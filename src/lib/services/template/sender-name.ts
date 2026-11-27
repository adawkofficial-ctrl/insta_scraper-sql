import { getPrismaClient } from "@/lib/db/prisma";

/**
 * Resolves the value for {{senderName}}: the account owner's name, falling
 * back to their first connected Instagram account's display name / username
 * so the sign-off never renders blank.
 */
export async function resolveTemplateSenderName(
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  const prisma = getPrismaClient();

  const owner = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });
  const ownerName = owner?.name?.trim();
  if (ownerName) return ownerName;

  const account = await prisma.instagramSenderAccount.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { displayName: true, username: true },
  });
  return account?.displayName?.trim() || account?.username?.trim() || null;
}
