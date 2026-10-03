import "server-only";

import path from "node:path";
import fs from "node:fs";

import { getServerEnv } from "@/lib/env";

/**
 * Default root for Instagram browser session profiles. Never an absolute
 * hardcoded path: it is resolved relative to the process working directory and
 * can be overridden with INSTAGRAM_SESSION_DIR.
 */
export const DEFAULT_INSTAGRAM_SESSION_DIR = "data/instagram-sessions";

export function getInstagramSessionRootDir(): string {
  const configured =
    getServerEnv("INSTAGRAM_SESSION_DIR") ?? DEFAULT_INSTAGRAM_SESSION_DIR;
  return path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(process.cwd(), configured);
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Non-secret reference stored on InstagramSenderAccount.sessionPath. It is
 * relative to the configured session root so it can never point at an
 * arbitrary absolute location.
 */
export function buildSenderSessionPath(
  userId: string,
  senderAccountId: string,
): string {
  return `${sanitizeSegment(userId)}/${sanitizeSegment(senderAccountId)}`;
}

/** Resolves a stored session reference to an absolute directory inside the root. */
export function resolveSenderSessionDir(sessionPath: string): string {
  const root = getInstagramSessionRootDir();
  const resolved = path.resolve(root, sessionPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      "Resolved Instagram session path escapes the configured session directory.",
    );
  }
  return resolved;
}

/** Creates the per-sender profile directory with restrictive permissions. */
export function ensureSenderSessionDir(sessionPath: string): string {
  const dir = resolveSenderSessionDir(sessionPath);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows / unsupported filesystems do not implement POSIX modes.
  }
  return dir;
}

/** Removes a sender's local session state (disconnect). Best-effort. */
export function removeSenderSessionDir(sessionPath: string): void {
  try {
    const dir = resolveSenderSessionDir(sessionPath);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore: the directory may not exist or may be locked on Windows.
  }
}

export function senderSessionDirExists(sessionPath: string): boolean {
  try {
    const dir = resolveSenderSessionDir(sessionPath);
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
