import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import {
  computeLeadGuardKeys,
  type LeadGuardKeys,
} from "@/lib/db/prisma";

export type LeadGuardKeyMismatch = {
  leadId: string;
  expected: LeadGuardKeys;
  actual: LeadGuardKeys;
};

export async function verifyLeadGuardKeys(options?: {
  batchSize?: number;
}): Promise<{
  checked: number;
  mismatches: LeadGuardKeyMismatch[];
}> {
  const prisma = getPrismaClient();
  const batchSize = options?.batchSize ?? 500;
  const mismatches: LeadGuardKeyMismatch[] = [];
  let checked = 0;
  let cursor: string | undefined;

  while (true) {
    const rows = await prisma.lead.findMany({
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      take: batchSize,
      orderBy: { id: "asc" },
      select: {
        id: true,
        instagramUserId: true,
        usernameNormalized: true,
        emailNormalized: true,
        duplicateOfLeadId: true,
        activeInstagramGuard: true,
        activeUsernameGuard: true,
        activeEmailGuard: true,
      },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      checked++;
      const expected = computeLeadGuardKeys(row);
      const actual: LeadGuardKeys = {
        activeInstagramGuard: row.activeInstagramGuard,
        activeUsernameGuard: row.activeUsernameGuard,
        activeEmailGuard: row.activeEmailGuard,
      };
      if (
        expected.activeInstagramGuard !== actual.activeInstagramGuard ||
        expected.activeUsernameGuard !== actual.activeUsernameGuard ||
        expected.activeEmailGuard !== actual.activeEmailGuard
      ) {
        mismatches.push({ leadId: row.id, expected, actual });
      }
    }
    cursor = rows[rows.length - 1]?.id;
  }

  return { checked, mismatches };
}
