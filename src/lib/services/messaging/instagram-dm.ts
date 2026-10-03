import "server-only";

import type { Page } from "playwright";

/**
 * Robust Instagram direct-message composer discovery + navigation.
 *
 * The previous implementation relied on two brittle CSS/text selectors
 * (`div[role="button"]:has-text("Message")` and `div[aria-label="Message"]`)
 * with no wait for the Instagram SPA conversation UI, so it reported
 * COMPOSER_NOT_FOUND even when the session/profile were healthy.
 *
 * Everything here uses stable semantics only: ARIA roles, accessible names,
 * `contenteditable`/`data-lexical-editor`, and placeholder text. No generated
 * React class names or hashed CSS classes are used.
 */

export type DmFailureCode =
  | "AUTH_REQUIRED"
  | "CAPTCHA_REQUIRED"
  | "RATE_LIMITED"
  | "ACCOUNT_RESTRICTED"
  | "RECIPIENT_NOT_FOUND"
  | "COMPOSER_NOT_FOUND"
  | "SEND_TIMEOUT";

export type CandidateDiagnostic = {
  description: string;
  count: number;
  visible: boolean;
  editable: boolean;
};

export type DmSendDiagnostics = {
  profileUrl: string;
  recipientUsername: string | null;
  currentUrl: string;
  pageTitle: string;
  authenticated: boolean;
  pagesCount: number;
  navigationSucceeded: boolean;
  pageState: string;
  /** Which component produced the classification (always instagram-dm here). */
  classificationSource: "instagram-dm";
  /** True only when an actual Instagram account-restriction UI was detected. */
  restrictionUiDetected: boolean;
  conversationUiDetected: boolean;
  messageActionFound: string | null;
  composerFound: string | null;
  composerCandidates: CandidateDiagnostic[];
  messageActionCandidates: CandidateDiagnostic[];
};

export type DmSendOutcome =
  | { success: true; diagnostics: DmSendDiagnostics }
  | {
      success: false;
      code: DmFailureCode;
      message: string;
      diagnostics: DmSendDiagnostics;
    };

export function safeDmUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.slice(0, 120);
  }
}

export function recipientUsernameFromProfileUrl(
  profileUrl: string,
): string | null {
  try {
    const url = new URL(profileUrl);
    const segment = url.pathname.split("/").filter(Boolean)[0];
    if (segment && /^[A-Za-z0-9._]{1,30}$/.test(segment)) {
      return segment;
    }
  } catch {
    // ignore
  }
  return null;
}

type LocatorCandidate = {
  description: string;
  locate: (page: Page) => ReturnType<Page["locator"]>;
};

/** Semantic composer candidates, most specific first. */
export function composerCandidates(): LocatorCandidate[] {
  return [
    {
      description: 'role=textbox name~/message/i',
      locate: (p) => p.getByRole("textbox", { name: /message/i }),
    },
    {
      description: 'div[role="textbox"][contenteditable="true"]',
      locate: (p) => p.locator('div[role="textbox"][contenteditable="true"]'),
    },
    {
      description: '[contenteditable="true"][data-lexical-editor="true"]',
      locate: (p) => p.locator('[contenteditable="true"][data-lexical-editor="true"]'),
    },
    {
      description: 'div[contenteditable="true"][aria-label*="Message" i]',
      locate: (p) => p.locator('div[contenteditable="true"][aria-label*="Message" i]'),
    },
    {
      description: 'textarea[placeholder*="Message" i]',
      locate: (p) => p.locator('textarea[placeholder*="Message" i]'),
    },
    {
      description: '[aria-label="Message..." i][contenteditable="true"]',
      locate: (p) => p.locator('[aria-label="Message..." i][contenteditable="true"]'),
    },
    {
      description: 'div[role="dialog"] [contenteditable="true"]',
      locate: (p) => p.locator('div[role="dialog"] [contenteditable="true"]'),
    },
    {
      description: '[contenteditable="true"] (generic fallback)',
      locate: (p) => p.locator('[contenteditable="true"]'),
    },
    {
      description: 'p[data-lexical-editor="true"]',
      locate: (p) => p.locator('p[data-lexical-editor="true"]'),
    },
  ];
}

/** Semantic "Message" action candidates on a profile, exact-text filtered. */
export function messageActionCandidates(): LocatorCandidate[] {
  return [
    {
      description: 'role=button name=/^Message$/i',
      locate: (p) => p.getByRole("button", { name: /^\s*message\s*$/i }),
    },
    {
      description: 'div[role="button"] text=Message',
      locate: (p) => p.locator('div[role="button"]').filter({ hasText: /^\s*Message\s*$/ }),
    },
    {
      description: 'button text=Message',
      locate: (p) => p.locator("button").filter({ hasText: /^\s*Message\s*$/ }),
    },
    {
      description: 'a[role="button"] text=Message',
      locate: (p) => p.locator('a[role="button"]').filter({ hasText: /^\s*Message\s*$/ }),
    },
  ];
}

export function recipientSearchCandidates(): LocatorCandidate[] {
  return [
    {
      description: 'role=textbox name~/search/i',
      locate: (p) => p.getByRole("textbox", { name: /search/i }),
    },
    {
      description: 'input[placeholder*="Search" i]',
      locate: (p) => p.locator('input[placeholder*="Search" i]'),
    },
    {
      description: 'input[name="query"]',
      locate: (p) => p.locator('input[name="query"]'),
    },
  ];
}

export type PageStateInspection = {
  code: "OK" | DmFailureCode;
  reason: string;
  currentUrl: string;
  pageTitle: string;
};

function textHas(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

/** Classifies the current page into an auth/challenge/rate/recipient state. */
export async function inspectDmPageState(page: Page): Promise<PageStateInspection> {
  const currentUrl = safeDmUrl(page.url());
  const pageTitle = await page.title().catch(() => "");
  const isLoginUrl = /\/(accounts\/login|accounts\/emailsignup)/.test(page.url());
  const isChallengeUrl = /\/(challenge|checkpoint)\//.test(page.url());
  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "")
    .then((text) => text.slice(0, 20000));

  const base = { currentUrl, pageTitle };

  if (isLoginUrl || textHas(bodyText, ["log in to instagram", "you must log in"])) {
    return { code: "AUTH_REQUIRED", reason: "Instagram requires login.", ...base };
  }
  if (isChallengeUrl || textHas(bodyText, ["security check", "confirm it's you"])) {
    return {
      code: "CAPTCHA_REQUIRED",
      reason: "Instagram presented a security challenge.",
      ...base,
    };
  }
  if (
    textHas(bodyText, [
      "action blocked",
      "try again later",
      "temporarily blocked",
      "we limit how often",
      "too many requests",
    ])
  ) {
    return {
      code: "RATE_LIMITED",
      reason: "Instagram reported a rate limit or temporary action block.",
      ...base,
    };
  }
  if (
    textHas(bodyText, [
      "your account has been restricted",
      "your account is restricted",
      "your account has been temporarily restricted",
      "we restricted your account",
      "account restricted",
    ])
  ) {
    return {
      code: "ACCOUNT_RESTRICTED",
      reason:
        "Instagram reported an account restriction that requires user action.",
      ...base,
    };
  }
  if (
    textHas(bodyText, [
      "sorry, this page isn't available",
      "page not found",
      "the link you followed may be broken",
      "user not found",
    ])
  ) {
    return {
      code: "RECIPIENT_NOT_FOUND",
      reason: "Instagram reported the recipient profile is not available.",
      ...base,
    };
  }

  return { code: "OK", reason: "Page is usable.", ...base };
}

async function inspectCandidates(
  page: Page,
  candidates: LocatorCandidate[],
): Promise<{ match: { description: string; locator: ReturnType<Page["locator"]> } | null; diagnostics: CandidateDiagnostic[] }> {
  const diagnostics: CandidateDiagnostic[] = [];
  for (const candidate of candidates) {
    const locator = candidate.locate(page);
    const count = await locator.count().catch(() => 0);
    let visible = false;
    let editable = false;
    if (count > 0) {
      const first = locator.first();
      visible = await first.isVisible().catch(() => false);
      editable = visible ? await first.isEditable().catch(() => false) : false;
    }
    diagnostics.push({ description: candidate.description, count, visible, editable });
    if (count > 0 && visible) {
      return { match: { description: candidate.description, locator }, diagnostics };
    }
  }
  return { match: null, diagnostics };
}

/** Polls the composer candidates until one is visible (handles SPA rendering). */
export async function waitForComposer(
  page: Page,
  timeoutMs: number,
): Promise<{
  match: { description: string; locator: ReturnType<Page["locator"]> } | null;
  diagnostics: CandidateDiagnostic[];
}> {
  const deadline = Date.now() + timeoutMs;
  let diagnostics: CandidateDiagnostic[] = [];
  while (true) {
    const result = await inspectCandidates(page, composerCandidates());
    diagnostics = result.diagnostics;
    if (result.match) {
      const editable = await result.match.locator.first().isEditable().catch(() => false);
      if (editable) return result;
    }
    if (Date.now() >= deadline) return { match: null, diagnostics };
    await page.waitForTimeout(400);
  }
}

export async function waitForMessageAction(
  page: Page,
  timeoutMs: number,
): Promise<{
  match: { description: string; locator: ReturnType<Page["locator"]> } | null;
  diagnostics: CandidateDiagnostic[];
}> {
  const deadline = Date.now() + timeoutMs;
  let diagnostics: CandidateDiagnostic[] = [];
  while (true) {
    const result = await inspectCandidates(page, messageActionCandidates());
    diagnostics = result.diagnostics;
    if (result.match) return result;
    if (Date.now() >= deadline) return { match: null, diagnostics };
    await page.waitForTimeout(300);
  }
}

export async function findRecipientSearchBox(
  page: Page,
): Promise<ReturnType<Page["locator"]> | null> {
  const { match } = await inspectCandidates(page, recipientSearchCandidates());
  return match ? match.locator.first() : null;
}

export type DmSendContext = {
  page: Page;
  profileUrl: string;
  /** Required for sending; optional for read-only diagnostics. */
  message?: string;
  authenticated: boolean;
  pagesCount?: number;
  /** Optional structured diagnostics sink (provider logs this). */
  onDiagnostic?: (diagnostics: DmSendDiagnostics) => void;
};

const NAV_TIMEOUT_MS = 45_000;
const COMPOSER_WAIT_MS = 15_000;
const MESSAGE_ACTION_WAIT_MS = 10_000;

export type DmInspectionOutcome =
  | {
      ok: true;
      composer: { description: string; locator: ReturnType<Page["locator"]> };
      diagnostics: DmSendDiagnostics;
    }
  | {
      ok: false;
      code: DmFailureCode;
      message: string;
      diagnostics: DmSendDiagnostics;
    };

/**
 * Navigates to the recipient and detects the conversation + composer WITHOUT
 * entering or sending anything. Safe for live diagnostics against a real,
 * logged-in sender account.
 */
export async function inspectInstagramDmTarget(
  context: DmSendContext,
): Promise<DmInspectionOutcome> {
  const { page } = context;
  const recipientUsername = recipientUsernameFromProfileUrl(context.profileUrl);

  const diagnostics: DmSendDiagnostics = {
    profileUrl: safeDmUrl(context.profileUrl),
    recipientUsername,
    currentUrl: safeDmUrl(page.url()),
    pageTitle: "",
    authenticated: context.authenticated,
    pagesCount: context.pagesCount ?? page.context().pages().length,
    navigationSucceeded: false,
    pageState: "UNKNOWN",
    classificationSource: "instagram-dm",
    restrictionUiDetected: false,
    conversationUiDetected: false,
    messageActionFound: null,
    composerFound: null,
    composerCandidates: [],
    messageActionCandidates: [],
  };

  const emit = (): void => {
    context.onDiagnostic?.(diagnostics);
  };
  const fail = (code: DmFailureCode, message: string): DmInspectionOutcome => {
    emit();
    return { ok: false, code, message, diagnostics };
  };

  try {
    await page.goto(context.profileUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    diagnostics.navigationSucceeded = true;
  } catch (error) {
    diagnostics.currentUrl = safeDmUrl(page.url());
    diagnostics.pageTitle = await page.title().catch(() => "");
    return fail(
      "SEND_TIMEOUT",
      "Timed out navigating to the Instagram recipient profile. " +
        (error instanceof Error ? error.message : ""),
    );
  }

  const state = await inspectDmPageState(page);
  diagnostics.currentUrl = state.currentUrl;
  diagnostics.pageTitle = state.pageTitle;
  diagnostics.pageState = state.code;
  diagnostics.restrictionUiDetected = state.code === "ACCOUNT_RESTRICTED";

  // Explicit session classification: never report COMPOSER_NOT_FOUND when the
  // real problem is authentication.
  if (!context.authenticated && state.code === "OK") {
    return fail(
      "AUTH_REQUIRED",
      "No authenticated Instagram session was found for this sender.",
    );
  }
  if (state.code !== "OK") {
    return fail(state.code, state.reason);
  }

  const alreadyOnThread = /\/direct\/(t|inbox|new)/.test(page.url());

  if (!alreadyOnThread) {
    const action = await waitForMessageAction(page, MESSAGE_ACTION_WAIT_MS);
    diagnostics.messageActionCandidates = action.diagnostics;
    if (!action.match) {
      return fail(
        "RECIPIENT_NOT_FOUND",
        "No Message action was available for this recipient (private profile, or direct messaging is unavailable).",
      );
    }
    diagnostics.messageActionFound = action.match.description;
    await action.match.locator.first().click().catch(() => undefined);
  }

  // Instagram may open the thread directly, or a "new message" search dialog.
  let composer = await waitForComposer(page, COMPOSER_WAIT_MS);
  diagnostics.composerCandidates = composer.diagnostics;

  if (!composer.match && recipientUsername) {
    const searchBox = await findRecipientSearchBox(page);
    if (searchBox) {
      await searchBox.click().catch(() => undefined);
      await searchBox.fill(recipientUsername).catch(() => undefined);
      const result = page
        .locator('div[role="button"], li')
        .filter({ hasText: new RegExp(`^\\s*${recipientUsername}\\s*$`, "i") })
        .first();
      await result.waitFor({ state: "visible", timeout: 8000 }).catch(() => undefined);
      await result.click().catch(() => undefined);
      composer = await waitForComposer(page, COMPOSER_WAIT_MS);
      diagnostics.composerCandidates = composer.diagnostics;
    }
  }

  diagnostics.conversationUiDetected = composer.match !== null;
  if (!composer.match) {
    diagnostics.currentUrl = safeDmUrl(page.url());
    diagnostics.pageTitle = await page.title().catch(() => "");
    return fail(
      "COMPOSER_NOT_FOUND",
      "Reached the Instagram conversation view but the message composer was not detected.",
    );
  }

  diagnostics.composerFound = composer.match.description;
  emit();
  return { ok: true, composer: composer.match, diagnostics };
}

/**
 * Detects the recipient conversation + composer, then enters and submits the
 * message. Returns a diagnostic snapshot for every outcome.
 */
export async function sendInstagramDirectMessage(
  context: DmSendContext,
): Promise<DmSendOutcome> {
  const { page } = context;
  const inspection = await inspectInstagramDmTarget(context);
  if (!inspection.ok) {
    return {
      success: false,
      code: inspection.code,
      message: inspection.message,
      diagnostics: inspection.diagnostics,
    };
  }

  const message = context.message ?? "";
  const composerLocator = inspection.composer.locator.first();
  try {
    await composerLocator.click({ timeout: 5000 }).catch(() => undefined);
    await composerLocator.fill(message);
  } catch {
    // Lexical editors occasionally reject fill(); fall back to typing.
    await composerLocator.click({ timeout: 5000 }).catch(() => undefined);
    await page.keyboard.type(message, { delay: 10 });
  }

  const sendButton = page.getByRole("button", { name: /^\s*send\s*$/i }).first();
  const sendButtonVisible = await sendButton.isVisible().catch(() => false);
  if (sendButtonVisible) {
    await sendButton.click().catch(() => undefined);
  } else {
    await page.keyboard.press("Enter");
  }

  await page.waitForTimeout(1500);
  return { success: true, diagnostics: inspection.diagnostics };
}
