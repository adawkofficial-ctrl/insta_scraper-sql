import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import type {
  InstagramSenderStatus,
  InstagramSenderSessionType,
  ConnectionMethod,
} from "@/generated/prisma/enums";

export type SenderAccountRecord = {
  id: string;
  userId: string;
  username: string;
  displayName: string | null;
  connectionMethod: ConnectionMethod;
  unipileAccountId: string | null;
  sessionType: InstagramSenderSessionType;
  sessionPath: string;
  status: InstagramSenderStatus;
  lastVerifiedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const SENDER_SELECT = {
  id: true,
  userId: true,
  username: true,
  displayName: true,
  connectionMethod: true,
  unipileAccountId: true,
  sessionType: true,
  sessionPath: true,
  status: true,
  lastVerifiedAt: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function listSenderAccountsForUser(
  userId: string,
): Promise<SenderAccountRecord[]> {
  return getPrismaClient().instagramSenderAccount.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: SENDER_SELECT,
  });
}

export async function findSenderAccountOwned(
  senderAccountId: string,
  userId: string,
): Promise<SenderAccountRecord | null> {
  return getPrismaClient().instagramSenderAccount.findFirst({
    where: { id: senderAccountId, userId },
    select: SENDER_SELECT,
  });
}

export async function findSenderAccountById(
  senderAccountId: string,
): Promise<SenderAccountRecord | null> {
  return getPrismaClient().instagramSenderAccount.findUnique({
    where: { id: senderAccountId },
    select: SENDER_SELECT,
  });
}

export async function findConnectedSenderForUser(
  userId: string,
): Promise<SenderAccountRecord | null> {
  return getPrismaClient().instagramSenderAccount.findFirst({
    where: { userId, status: "CONNECTED" },
    orderBy: { lastVerifiedAt: "desc" },
    select: SENDER_SELECT,
  });
}

export async function findSenderByUsername(
  userId: string,
  username: string,
): Promise<SenderAccountRecord | null> {
  return getPrismaClient().instagramSenderAccount.findFirst({
    where: { userId, username },
    select: SENDER_SELECT,
  });
}

export async function countSenderAccountsForUser(
  userId: string,
): Promise<number> {
  return getPrismaClient().instagramSenderAccount.count({ where: { userId } });
}

export async function createSenderAccountRecord(input: {
  userId: string;
  username: string;
  displayName?: string | null;
  connectionMethod?: ConnectionMethod;
  unipileAccountId?: string | null;
  sessionType?: InstagramSenderSessionType;
  sessionPath: string;
  status?: InstagramSenderStatus;
}): Promise<SenderAccountRecord> {
  return getPrismaClient().instagramSenderAccount.create({
    data: {
      userId: input.userId,
      username: input.username,
      displayName: input.displayName ?? null,
      connectionMethod: input.connectionMethod ?? "PLAYWRIGHT",
      unipileAccountId: input.unipileAccountId ?? null,
      sessionType: input.sessionType ?? "PERSISTENT_PROFILE",
      sessionPath: input.sessionPath,
      status: input.status ?? "CONNECTING",
    },
    select: SENDER_SELECT,
  });
}

export async function updateSenderAccountRecord(
  senderAccountId: string,
  data: {
    username?: string;
    displayName?: string | null;
    connectionMethod?: ConnectionMethod;
    unipileAccountId?: string | null;
    sessionType?: InstagramSenderSessionType;
    sessionPath?: string;
    status?: InstagramSenderStatus;
    lastVerifiedAt?: Date | null;
    lastError?: string | null;
  },
): Promise<SenderAccountRecord> {
  return getPrismaClient().instagramSenderAccount.update({
    where: { id: senderAccountId },
    data,
    select: SENDER_SELECT,
  });
}

export async function deleteSenderAccountRecord(
  senderAccountId: string,
): Promise<void> {
  await getPrismaClient().instagramSenderAccount.delete({
    where: { id: senderAccountId },
  });
}
