/**
 * Framework-agnostic job status polling.
 *
 * The previous implementation created a `setInterval` inside a React effect
 * whose dependency list contained an inline callback prop. Every poll notified
 * the parent, the parent re-rendered with a new callback identity, the effect
 * was torn down and re-run, and it immediately fetched again — an unbounded
 * request loop that continued even after the job reached a terminal state.
 *
 * This helper polls with a self-terminating recursive timeout, never runs two
 * timers at once, and stops permanently on a terminal status or `stop()`.
 */

/** Terminal statuses, taken from the Prisma `BulkMessageJobStatus` enum. */
export const TERMINAL_BULK_JOB_STATUSES = [
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
] as const;

export type TerminalBulkJobStatus = (typeof TERMINAL_BULK_JOB_STATUSES)[number];

export function isTerminalBulkJobStatus(
  status: string | null | undefined,
): status is TerminalBulkJobStatus {
  return (
    status != null &&
    (TERMINAL_BULK_JOB_STATUSES as readonly string[]).includes(status)
  );
}

export type JobPollingHandle = {
  /** Stops scheduling and prevents any further callback. Idempotent. */
  stop(): void;
  isStopped(): boolean;
};

export type StartJobPollingOptions = {
  intervalMs: number;
  /** Fetches the current status. Return null to skip notifications. */
  fetchStatus: () => Promise<string | null>;
  /** Invoked only when the status CHANGES (never twice for the same value). */
  onStatus: (status: string) => void;
  onError?: (error: unknown) => void;
  /** Test injectables. */
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
};

export function startJobPolling(
  options: StartJobPollingOptions,
): JobPollingHandle {
  const setTimeoutFn =
    options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let stopped = false;
  let inFlight = false;
  let timer: unknown = null;
  let lastStatus: string | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    clearTimer();
    // A single timeout per loop (never an interval), so no duplicate timers.
    timer = setTimeoutFn(() => {
      void tick();
    }, options.intervalMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    let status: string | null = null;
    try {
      status = await options.fetchStatus();
      if (stopped) return;
      if (status !== null && status !== lastStatus) {
        lastStatus = status;
        options.onStatus(status);
      }
    } catch (error) {
      if (!stopped) {
        options.onError?.(error);
      }
    } finally {
      inFlight = false;
    }

    if (stopped) return;
    if (isTerminalBulkJobStatus(status)) {
      stopped = true;
      clearTimer();
      return;
    }
    schedule();
  };

  // Kick off the immediate first fetch, then poll until terminal.
  void tick();

  return {
    stop(): void {
      stopped = true;
      clearTimer();
    },
    isStopped(): boolean {
      return stopped;
    },
  };
}
