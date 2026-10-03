import { createHash } from "node:crypto";

/**
 * Stable hash of the exact final draft body. Used for the approval contract:
 * a draft is sendable only while hash(currentFinalBody) === approvedBodyHash.
 * Any edit (even whitespace) changes the hash.
 */
export function draftBodyHash(body: string | null | undefined): string {
  return createHash("sha256").update(body ?? "", "utf8").digest("hex");
}
