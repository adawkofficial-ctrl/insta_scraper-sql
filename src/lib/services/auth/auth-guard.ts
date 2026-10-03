import "server-only";

import { cookies } from "next/headers";
import { getPrismaClient } from "@/lib/db/prisma";
import { NotFoundError, UnauthorizedError } from "@/lib/errors";
import {
  SESSION_COOKIE_NAME,
  verifySessionToken,
  getUserById,
  type SafeUser,
} from "./auth-service";

export async function extractTokenFromRequest(request?: Request): Promise<string | null> {
  // 1. Check Authorization Bearer header
  if (request) {
    const authHeader = request.headers.get("authorization");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      if (token) return token;
    }

    // 2. Check Cookie header on request
    const cookieHeader = request.headers.get("cookie");
    if (cookieHeader) {
      const cookiesArr = cookieHeader.split(";");
      for (const cookie of cookiesArr) {
        const [rawName, ...rawVal] = cookie.trim().split("=");
        if (rawName === SESSION_COOKIE_NAME) {
          const val = rawVal.join("=");
          if (val) return decodeURIComponent(val);
        }
      }
    }
  }

  // 3. Check next/headers cookies store if available
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);
    if (sessionCookie?.value) {
      return sessionCookie.value;
    }
  } catch {
    // cookies() might fail outside Next.js request context (e.g. testing scripts)
  }

  return null;
}

export async function getCurrentUser(request?: Request): Promise<SafeUser | null> {
  const token = await extractTokenFromRequest(request);
  if (!token) return null;

  const payload = await verifySessionToken(token);
  if (!payload || !payload.sub) return null;

  const user = await getUserById(payload.sub);
  return user;
}

export async function requireAuth(request?: Request): Promise<SafeUser> {
  const user = await getCurrentUser(request);
  if (!user) {
    throw new UnauthorizedError("AUTH_REQUIRED", "Authentication is required to perform this action.");
  }
  return user;
}

export async function requireCampaignOwner(campaignId: string, userId: string) {
  const prisma = getPrismaClient();
  const campaign = await prisma.campaign.findFirst({
    where: {
      id: campaignId,
      userId,
    },
    select: {
      id: true,
      name: true,
      status: true,
      executionMode: true,
      messageApprovalRequired: true,
      scheduledAt: true,
      userId: true,
    },
  });

  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND", "Campaign not found");
  }

  return campaign;
}

export async function requireLeadOwner(leadId: string, userId: string) {
  const prisma = getPrismaClient();
  const lead = await prisma.lead.findFirst({
    where: {
      id: leadId,
      campaign: {
        userId,
      },
    },
    include: {
      campaign: {
        select: {
          id: true,
          userId: true,
          name: true,
        },
      },
    },
  });

  if (!lead) {
    throw new NotFoundError("LEAD_NOT_FOUND", "Lead not found");
  }

  return lead;
}

export async function requireExecutionOwner(executionId: string, userId: string) {
  const prisma = getPrismaClient();
  const execution = await prisma.campaignExecution.findFirst({
    where: {
      id: executionId,
      campaign: {
        userId,
      },
    },
    include: {
      campaign: {
        select: {
          id: true,
          userId: true,
          name: true,
        },
      },
    },
  });

  if (!execution) {
    throw new NotFoundError("EXECUTION_NOT_FOUND", "Execution not found");
  }

  return execution;
}

export async function requireTemplateOwner(templateId: string, userId: string) {
  const prisma = getPrismaClient();
  const template = await prisma.messageTemplate.findFirst({
    where: {
      id: templateId,
      OR: [
        { campaignId: null },
        {
          campaign: {
            userId,
          },
        },
      ],
    },
  });

  if (!template) {
    throw new NotFoundError("TEMPLATE_NOT_FOUND", "Message template not found");
  }

  return template;
}
