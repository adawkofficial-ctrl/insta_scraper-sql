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
  lastSentAt: Date | null;
  sentToday: number;
  sentTodayDate: string | null;
  sentThisHour: number;
  sentThisHourWindow: string | null;
  totalSent: number;
  warmupStartedAt: Date | null;
  pausedUntil: Date | null;
  lastErrorCode: string | null;
  consecutiveErrors: number;
  dailyCap: number | null;
  hourlyCap: number | null;
  customMinGapSeconds: number | null;
  customMaxGapSeconds: number | null;
  timezone: string;
  workingHoursStart: number;
  workingHoursEnd: number;
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
  lastSentAt: true,
  sentToday: true,
  sentTodayDate: true,
  sentThisHour: true,
  sentThisHourWindow: true,
  totalSent: true,
  warmupStartedAt: true,
  pausedUntil: true,
  lastErrorCode: true,
  consecutiveErrors: true,
  dailyCap: true,
  hourlyCap: true,
  customMinGapSeconds: true,
  customMaxGapSeconds: true,
  timezone: true,
  workingHoursStart: true,
  workingHoursEnd: true,
} as const;

export async function listSenderAccountsForUser(
  userId: string,
): Promise<SenderAccountRecord[]> {
  const prisma = getPrismaClient();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (user?.role === "ADMIN") {
    return prisma.instagramSenderAccount.findMany({
      where: {
        OR: [
          { userId },
          { user: { role: "ADMIN" } },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: SENDER_SELECT,
    });
  }
  return prisma.instagramSenderAccount.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: SENDER_SELECT,
  });
}

export async function findSenderAccountOwned(
  senderAccountId: string,
  userId: string,
): Promise<SenderAccountRecord | null> {
  const prisma = getPrismaClient();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (user?.role === "ADMIN") {
    return prisma.instagramSenderAccount.findFirst({
      where: {
        id: senderAccountId,
        OR: [{ userId }, { user: { role: "ADMIN" } }],
      },
      select: SENDER_SELECT,
    });
  }
  return prisma.instagramSenderAccount.findFirst({
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

const ELIGIBLE_CONNECTED_STATUSES: InstagramSenderStatus[] = [
  "CONNECTED",
  "ACTIVE",
  "WARMING",
];

export async function findConnectedSenderForUser(
  userId: string,
): Promise<SenderAccountRecord | null> {
  const prisma = getPrismaClient();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (user?.role === "ADMIN") {
    return prisma.instagramSenderAccount.findFirst({
      where: {
        status: { in: ELIGIBLE_CONNECTED_STATUSES },
        OR: [{ userId }, { user: { role: "ADMIN" } }],
      },
      orderBy: { lastVerifiedAt: "desc" },
      select: SENDER_SELECT,
    });
  }
  return prisma.instagramSenderAccount.findFirst({
    where: { userId, status: { in: ELIGIBLE_CONNECTED_STATUSES } },
    orderBy: { lastVerifiedAt: "desc" },
    select: SENDER_SELECT,
  });
}

export async function findConnectedSendersForUser(
  userId: string,
): Promise<SenderAccountRecord[]> {
  const prisma = getPrismaClient();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (user?.role === "ADMIN") {
    return prisma.instagramSenderAccount.findMany({
      where: {
        status: { in: ELIGIBLE_CONNECTED_STATUSES },
        OR: [{ userId }, { user: { role: "ADMIN" } }],
      },
      orderBy: { createdAt: "asc" },
      select: SENDER_SELECT,
    });
  }
  return prisma.instagramSenderAccount.findMany({
    where: { userId, status: { in: ELIGIBLE_CONNECTED_STATUSES } },
    orderBy: { createdAt: "asc" },
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
    dailyCap?: number | null;
    hourlyCap?: number | null;
    customMinGapSeconds?: number | null;
    customMaxGapSeconds?: number | null;
    pausedUntil?: Date | null;
    lastErrorCode?: string | null;
    consecutiveErrors?: number;
    timezone?: string;
    workingHoursStart?: number;
    workingHoursEnd?: number;
    warmupStartedAt?: Date | null;
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
