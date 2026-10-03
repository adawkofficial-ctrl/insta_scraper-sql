import "dotenv/config";
import http from "node:http";
import { chromium } from "playwright";

import {
  sendInstagramDirectMessage,
  type DmSendDiagnostics,
} from "../src/lib/services/messaging/instagram-dm";
import {
  getRetryDecision,
  shouldAutoRetryMessageDelivery,
  classifyErrorCode,
} from "../src/lib/services/errors/retry-policy";
import { classifyMessagingError } from "../src/lib/services/messaging/error-classifier";

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

const SECRET_MESSAGE = "SECRET_TEST_MESSAGE_DO_NOT_SEND";

const COMPOSER =
  '<div role="textbox" contenteditable="true" aria-label="Message..." data-lexical-editor="true"></div>';

function html(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function buildFixtures(): Record<string, string> {
  return {
    // Profile with a working Message action -> conversation with a composer.
    "/profile-ok/": html(
      "Profile",
      '<header><div role="button" tabindex="0" onclick="location.href=\'/direct/t/123/\'">Message</div></header><main>@target</main>',
    ),
    "/direct/t/123/": html("Direct", `<main>${COMPOSER}</main>`),

    // Profile action opens a "new message" search dialog.
    "/searchuser/": html(
      "Profile",
      '<header><div role="button" tabindex="0" onclick="location.href=\'/direct/new/\'">Message</div></header><main>@searchuser</main>',
    ),
    "/direct/new/": html(
      "New message",
      `<input placeholder="Search..." />
       <div id="results"></div>
       <script>
         function showComposer(){ document.body.innerHTML = ${JSON.stringify(COMPOSER)}; }
         document.querySelector('input').addEventListener('input', function(e){
           document.getElementById('results').innerHTML =
             '<div role="button" onclick="showComposer()">' + e.target.value + '</div>';
         });
       </script>`,
    ),

    // Composer only appears after an SPA delay (initial loading skeleton).
    "/slowuser/": html(
      "Profile",
      '<header><div role="button" tabindex="0" onclick="location.href=\'/direct/t/slow/\'">Message</div></header>',
    ),
    "/direct/t/slow/": html(
      "Direct",
      `<main><div id="skeleton">Loading...</div></main>
       <script>setTimeout(function(){ document.querySelector('main').innerHTML = ${JSON.stringify(COMPOSER)}; }, 2500);</script>`,
    ),

    // Profile with no Message action (private / restricted).
    "/privateuser/": html("Profile", "<main>This account is private</main>"),

    // Message action exists but the conversation never renders a composer.
    "/noinput/": html(
      "Profile",
      '<header><div role="button" tabindex="0" onclick="location.href=\'/direct/t/none/\'">Message</div></header>',
    ),
    "/direct/t/none/": html("Direct", "<main>Select a conversation</main>"),

    // Auth / security / rate / restriction / missing states.
    "/accounts/login/": html("Login", "<main>Log in to Instagram</main>"),
    "/rateuser/": html("Profile", "<main>Action Blocked — Try Again Later</main>"),
    "/restricted/": html(
      "Profile",
      "<main>Your account has been restricted from sending messages.</main>",
    ),
    "/missing/": html("Profile", "<main>Sorry, this page isn't available.</main>"),
  };
}

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const fixtures = buildFixtures();
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const body = fixtures[path] ?? html("404", "<main>Not found</main>");
    res.writeHead(fixtures[path] ? 200 : 404, { "Content-Type": "text/html" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ channel: "chromium", headless: true });

  console.log("=================================================================");
  console.log("   TASK 23: REAL-BROWSER DM COMPOSER DETECTION (FIXTURES)        ");
  console.log("=================================================================\n");

  const run = async (
    path: string,
    opts: { authenticated?: boolean } = {},
  ): Promise<{ success: boolean; code?: string; diagnostics: DmSendDiagnostics }> => {
    const page = await browser.newPage();
    try {
      const outcome = await sendInstagramDirectMessage({
        page,
        profileUrl: `${server.url}${path}`,
        message: SECRET_MESSAGE,
        authenticated: opts.authenticated ?? true,
      });
      if (outcome.success) {
        return { success: true, diagnostics: outcome.diagnostics };
      }
      return { success: false, code: outcome.code, diagnostics: outcome.diagnostics };
    } finally {
      await page.close().catch(() => undefined);
    }
  };

  // 1. Composer found (profile -> Message -> conversation -> composer).
  {
    const result = await run("/profile-ok/");
    check(result.success, "[found] send succeeds when composer is detected", result.code);
    check(
      result.diagnostics.composerFound !== null,
      `[found] matched composer candidate recorded (${result.diagnostics.composerFound})`,
    );
    check(
      result.diagnostics.messageActionFound !== null,
      `[found] matched Message action recorded (${result.diagnostics.messageActionFound})`,
    );
    check(result.diagnostics.conversationUiDetected, "[found] conversation UI detected");
  }

  // 2. Search-dialog flow (Message -> /direct/new/ -> search -> composer).
  {
    const result = await run("/searchuser/");
    check(result.success, "[search] composer found after recipient search", result.code);
    check(result.diagnostics.recipientUsername === "searchuser", "[search] recipient derived from URL");
  }

  // 3. Slow SPA composer rendering is tolerated.
  {
    const result = await run("/slowuser/");
    check(result.success, "[slow] composer detected after delayed render", result.code);
  }

  // 4. Composer genuinely missing -> COMPOSER_NOT_FOUND with candidate diagnostics.
  {
    const result = await run("/noinput/");
    check(result.code === "COMPOSER_NOT_FOUND", `[missing] code is COMPOSER_NOT_FOUND (got ${result.code})`);
    check(
      result.diagnostics.composerCandidates.length > 0,
      "[missing] candidate diagnostics recorded",
    );
    check(
      result.diagnostics.composerCandidates.every((c) => c.visible === false || c.editable === false),
      "[missing] no editable composer reported",
    );
  }

  // 5. No Message action (private/restricted) -> RECIPIENT_NOT_FOUND, not COMPOSER_NOT_FOUND.
  {
    const result = await run("/privateuser/");
    check(result.code === "RECIPIENT_NOT_FOUND", `[restricted] code is RECIPIENT_NOT_FOUND (got ${result.code})`);
  }

  // 6. Recipient page unavailable -> RECIPIENT_NOT_FOUND.
  {
    const result = await run("/missing/");
    check(result.code === "RECIPIENT_NOT_FOUND", `[missing-profile] code (got ${result.code})`);
  }

  // 7. Login redirect -> AUTH_REQUIRED.
  {
    const result = await run("/accounts/login/");
    check(result.code === "AUTH_REQUIRED", `[login] code is AUTH_REQUIRED (got ${result.code})`);
  }

  // 8. Logged-out context on a normal profile -> AUTH_REQUIRED (not COMPOSER_NOT_FOUND).
  {
    const result = await run("/profile-ok/", { authenticated: false });
    check(result.code === "AUTH_REQUIRED", `[session] unauthenticated -> AUTH_REQUIRED (got ${result.code})`);
  }

  // 9. Rate limit -> RATE_LIMITED.
  {
    const result = await run("/rateuser/");
    check(result.code === "RATE_LIMITED", `[rate] code is RATE_LIMITED (got ${result.code})`);
  }

  // 9b. Actual account-restriction UI -> ACCOUNT_RESTRICTED (and flagged).
  {
    const result = await run("/restricted/");
    check(
      result.code === "ACCOUNT_RESTRICTED",
      `[restriction] code is ACCOUNT_RESTRICTED (got ${result.code})`,
    );
    check(
      result.diagnostics.restrictionUiDetected === true,
      "[restriction] restrictionUiDetected is true only for real restriction UI",
    );
  }

  // 9c. No-Message-action case must NOT be flagged as a restriction UI.
  {
    const result = await run("/privateuser/");
    check(
      result.diagnostics.restrictionUiDetected === false,
      "[no-message] restrictionUiDetected false when only the action is missing",
    );
  }

  // 9d. Classifier regression: an explicit DM code must not be overridden by
  // incidental words in its message (this was the live ACCOUNT_RESTRICTED bug).
  {
    const direct = classifyErrorCode(
      "RECIPIENT_NOT_FOUND",
      "No Message action was available for this recipient (private, restricted, or messaging is unavailable).",
    );
    check(
      direct === "RECIPIENT_NOT_FOUND",
      `[classifier] explicit RECIPIENT_NOT_FOUND not overridden by 'restricted' text (got ${direct})`,
    );
    const mediated = classifyMessagingError(
      "RECIPIENT_NOT_FOUND",
      "No Message action was available for this recipient (private, restricted, or messaging is unavailable).",
    );
    check(
      mediated.code === "RECIPIENT_NOT_FOUND",
      `[classifier] messaging classifier keeps RECIPIENT_NOT_FOUND (got ${mediated.code})`,
    );
    check(
      mediated.isFatalPlatformRestriction === false,
      "[classifier] recipient-unavailable is not a fatal platform restriction",
    );
    const composer = classifyMessagingError("COMPOSER_NOT_FOUND", "composer missing");
    check(composer.code === "COMPOSER_NOT_FOUND", "[classifier] COMPOSER_NOT_FOUND preserved");
    // Message-only heuristic (no explicit code) still detects a real restriction.
    const restriction = classifyMessagingError(
      "Your account has been temporarily restricted from sending direct messages",
    );
    check(
      restriction.code === "ACCOUNT_RESTRICTED",
      `[classifier] restriction text still classifies as ACCOUNT_RESTRICTED (got ${restriction.code})`,
    );
  }

  // 10. Diagnostics never leak the message content.
  {
    const result = await run("/profile-ok/");
    const serialized = JSON.stringify(result.diagnostics);
    check(
      !serialized.includes(SECRET_MESSAGE),
      "[secrets] diagnostics do not contain message content",
    );
    check(
      !/cookie|sessionid|password|token|storage[-_ ]?state/i.test(serialized),
      "[secrets] diagnostics contain no cookies/tokens",
    );
  }

  // 11. Deterministic COMPOSER_NOT_FOUND must not auto-retry (no repeated relaunch).
  {
    const decision = getRetryDecision({
      code: "COMPOSER_NOT_FOUND",
      attempt: 1,
      domain: "messaging",
      outcomeKnown: true,
    });
    check(!decision.retry, "[retry] COMPOSER_NOT_FOUND is not auto-retried");
    check(
      !shouldAutoRetryMessageDelivery({
        itemStatus: "FAILED",
        errorCode: "COMPOSER_NOT_FOUND",
        outcomeKnown: true,
      }),
      "[retry] shouldAutoRetryMessageDelivery false for COMPOSER_NOT_FOUND",
    );
    check(
      !getRetryDecision({
        code: "ACCOUNT_RESTRICTED",
        attempt: 1,
        domain: "messaging",
        outcomeKnown: true,
      }).retry,
      "[retry] ACCOUNT_RESTRICTED is not auto-retried",
    );
    check(
      !getRetryDecision({
        code: "RECIPIENT_NOT_FOUND",
        attempt: 1,
        domain: "messaging",
        outcomeKnown: true,
      }).retry,
      "[retry] RECIPIENT_NOT_FOUND (messaging unavailable) is not auto-retried",
    );
  }

  await browser.close();
  await server.close();

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Unexpected failure:", error);
  process.exit(1);
});
