import "server-only";

import { promises as dns } from "node:dns";

const EMAIL_SYNTAX =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const BLOCKED_LOCAL_PARTS = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "webmaster",
  "privacy",
  "careers",
  "abuse",
]);

const GENERIC_LOCAL_PARTS = new Set([
  "info",
  "contact",
  "office",
  "hello",
  "hi",
  "admin",
  "sales",
  "support",
  "bookings",
  "appointments",
]);

const FREE_PROVIDER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "protonmail.com",
]);

export type EmailAddressQuality = {
  normalized: string | null;
  domain: string | null;
  valid: boolean;
  role: "generic" | "named" | "blocked" | null;
  reason: string | null;
  hasMx: boolean | null;
};

export function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function getEmailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
}

export function isFreeProviderDomain(domain: string): boolean {
  return FREE_PROVIDER_DOMAINS.has(domain.toLowerCase());
}

export type MxResolver = (domain: string) => Promise<string[]>;

const defaultMxResolver: MxResolver = async (domain) => {
  const records = await dns.resolveMx(domain);
  return records.map((r) => r.exchange).filter(Boolean);
};

export async function checkEmailAddress(
  raw: string | null | undefined,
  options?: { checkMx?: boolean; resolver?: MxResolver },
): Promise<EmailAddressQuality> {
  const normalized = normalizeEmail(raw);
  if (!normalized || !EMAIL_SYNTAX.test(normalized)) {
    return {
      normalized,
      domain: normalized ? getEmailDomain(normalized) : null,
      valid: false,
      role: null,
      reason: "Invalid email syntax",
      hasMx: null,
    };
  }

  const domain = getEmailDomain(normalized);
  const local = normalized.slice(0, normalized.lastIndexOf("@"));
  if (BLOCKED_LOCAL_PARTS.has(local)) {
    return {
      normalized,
      domain,
      valid: false,
      role: "blocked",
      reason: `Role address "${local}@" is not allowed`,
      hasMx: null,
    };
  }

  let hasMx: boolean | null = null;
  if (options?.checkMx) {
    try {
      const records = await (options.resolver ?? defaultMxResolver)(domain!);
      hasMx = records.length > 0;
    } catch {
      hasMx = false;
    }
    if (!hasMx) {
      return {
        normalized,
        domain,
        valid: false,
        role: null,
        reason: "Domain has no MX records",
        hasMx,
      };
    }
  }

  return {
    normalized,
    domain,
    valid: true,
    role: GENERIC_LOCAL_PARTS.has(local) ? "generic" : "named",
    reason: null,
    hasMx,
  };
}
