import "dotenv/config";

import {
  isTerminalBulkJobStatus,
  startJobPolling,
  TERMINAL_BULK_JOB_STATUSES,
} from "../src/lib/polling/job-polling";

let passed = 0;
let failed = 0;
function check(cond: boolean, name: string, detail?: string) {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Deterministic timer double: no real time passes, timers are drained manually. */
class FakeTimers {
  private queue = new Map<number, () => void>();
  private nextId = 1;
  setTimeout = (handler: () => void): unknown => {
    const id = this.nextId++;
    this.queue.set(id, handler);
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.queue.delete(handle as number);
  };
  pending(): number {
    return this.queue.size;
  }
  async runNext(): Promise<boolean> {
    const entry = this.queue.entries().next();
    if (entry.done) return false;
    const [id, handler] = entry.value;
    this.queue.delete(id);
    handler();
    await flush();
    return true;
  }
}

async function main() {
  console.log("=================================================================");
  console.log("   TASK 21: JOB POLLING LIFECYCLE (FAKE TIMERS)                  ");
  console.log("=================================================================\n");

  // Terminal status helper matches the Prisma enum values.
  check(
    TERMINAL_BULK_JOB_STATUSES.join(",") === "COMPLETED,PARTIAL,FAILED,CANCELLED",
    "terminal statuses match BulkMessageJobStatus enum",
  );
  check(isTerminalBulkJobStatus("COMPLETED"), "COMPLETED is terminal");
  check(isTerminalBulkJobStatus("PARTIAL"), "PARTIAL is terminal");
  check(isTerminalBulkJobStatus("FAILED"), "FAILED is terminal");
  check(isTerminalBulkJobStatus("CANCELLED"), "CANCELLED is terminal");
  check(!isTerminalBulkJobStatus("RUNNING"), "RUNNING is not terminal");
  check(!isTerminalBulkJobStatus("PAUSED"), "PAUSED is not terminal");
  check(!isTerminalBulkJobStatus("QUEUED"), "QUEUED is not terminal");

  // Generic polling harness.
  // 1. Polling starts once and schedules exactly one timer.
  {
    const status = "RUNNING";
    const timers = new FakeTimers();
    const notifications: string[] = [];
    let fetches = 0;
    const handle = startJobPolling({
      intervalMs: 2500,
      fetchStatus: async () => {
        fetches += 1;
        return status;
      },
      onStatus: (s) => notifications.push(s),
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    await flush();
    check(fetches === 1, "[start] one immediate fetch on start");
    check(timers.pending() === 1, "[start] exactly one timer scheduled");
    handle.stop();
  }

  // 2. Terminal status stops polling (and no timer remains).
  {
    let status = "RUNNING";
    const timers = new FakeTimers();
    const notifications: string[] = [];
    const handle = startJobPolling({
      intervalMs: 2500,
      fetchStatus: async () => status,
      onStatus: (s) => notifications.push(s),
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    await flush();
    check(notifications.join(",") === "RUNNING", "[terminal] notified once for RUNNING");
    status = "COMPLETED";
    await timers.runNext();
    check(handle.isStopped(), "[terminal] polling stopped after COMPLETED");
    check(timers.pending() === 0, "[terminal] no timer remains after COMPLETED");
    check(
      notifications.join(",") === "RUNNING,COMPLETED",
      "[terminal] status change notified exactly once",
    );
    // Advancing further must not fetch again.
    const extra = await timers.runNext();
    check(!extra, "[terminal] no further timers to run");
  }

  // 3. FAILED stops polling.
  {
    const timers = new FakeTimers();
    const handle = startJobPolling({
      intervalMs: 2500,
      fetchStatus: async () => "FAILED",
      onStatus: () => undefined,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    await flush();
    check(handle.isStopped(), "[failed] polling stops immediately on FAILED");
    check(timers.pending() === 0, "[failed] no timer remains");
  }

  // 4. CANCELLED stops polling.
  {
    const timers = new FakeTimers();
    const handle = startJobPolling({
      intervalMs: 2500,
      fetchStatus: async () => "CANCELLED",
      onStatus: () => undefined,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    await flush();
    check(handle.isStopped(), "[cancelled] polling stops immediately on CANCELLED");
    check(timers.pending() === 0, "[cancelled] no timer remains");
  }

  // 5. stop() clears the pending timer (unmount cleanup).
  {
    const timers = new FakeTimers();
    const handle = startJobPolling({
      intervalMs: 2500,
      fetchStatus: async () => "RUNNING",
      onStatus: () => undefined,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    await flush();
    check(timers.pending() === 1, "[cleanup] timer pending before stop");
    handle.stop();
    check(timers.pending() === 0, "[cleanup] stop() cleared the timer");
    check(handle.isStopped(), "[cleanup] handle reports stopped");
  }

  // 6. Statuses are only notified when they change (no duplicate parent refresh).
  {
    const statuses = ["RUNNING", "RUNNING", "RUNNING", "PAUSED", "PAUSED", "COMPLETED"];
    let index = 0;
    const timers = new FakeTimers();
    const notifications: string[] = [];
    const handle = startJobPolling({
      intervalMs: 2500,
      fetchStatus: async () => statuses[Math.min(index++, statuses.length - 1)],
      onStatus: (s) => notifications.push(s),
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    await flush();
    await timers.runNext();
    await timers.runNext();
    await timers.runNext();
    check(
      notifications.join(",") === "RUNNING,PAUSED",
      `[dedupe] repeated RUNNING not re-notified (got ${notifications.join(",")})`,
    );
    while (await timers.runNext()) {
      // drain to terminal
    }
    check(notifications[notifications.length - 1] === "COMPLETED", "[dedupe] COMPLETED notified");
    check(handle.isStopped(), "[dedupe] stopped at terminal");
  }

  // 7. Errors keep polling (transient failures must not silently stop it).
  {
    const timers = new FakeTimers();
    let errors = 0;
    let shouldFail = true;
    const handle = startJobPolling({
      intervalMs: 2500,
      fetchStatus: async () => {
        if (shouldFail) throw new Error("network");
        return "RUNNING";
      },
      onStatus: () => undefined,
      onError: () => {
        errors += 1;
      },
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    await flush();
    check(errors === 1, "[error] error reported");
    check(timers.pending() === 1, "[error] polling continues after an error");
    check(!handle.isStopped(), "[error] not stopped by a transient error");
    shouldFail = false;
    handle.stop();
  }

  // 8. Strict Mode double-invoke: the first effect's poller is stopped by its
  // cleanup, leaving exactly one active timer (no duplicate polling).
  {
    const timers = new FakeTimers();
    const first = startJobPolling({
      intervalMs: 2500,
      fetchStatus: async () => "RUNNING",
      onStatus: () => undefined,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    await flush();
    first.stop(); // React Strict Mode cleanup of the first effect
    const second = startJobPolling({
      intervalMs: 2500,
      fetchStatus: async () => "RUNNING",
      onStatus: () => undefined,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    await flush();
    check(
      timers.pending() === 1,
      `[strict] exactly one active timer after Strict Mode double-invoke (got ${timers.pending()})`,
    );
    check(first.isStopped() && !second.isStopped(), "[strict] only the second poller is active");
    second.stop();
  }

  // 9. Changing jobId: old poller stopped, new one active (one timer total).
  {
    const timers = new FakeTimers();
    const oldJob = startJobPolling({
      intervalMs: 2500,
      fetchStatus: async () => "RUNNING",
      onStatus: () => undefined,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    await flush();
    oldJob.stop(); // jobId changed -> cleanup
    const newJob = startJobPolling({
      intervalMs: 2500,
      fetchStatus: async () => "RUNNING",
      onStatus: () => undefined,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
    });
    await flush();
    check(
      timers.pending() === 1,
      `[jobId] exactly one timer after switching jobId (got ${timers.pending()})`,
    );
    check(oldJob.isStopped() && !newJob.isStopped(), "[jobId] old poller stopped, new active");
    newJob.stop();
  }

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Unexpected failure:", error);
  process.exit(1);
});
