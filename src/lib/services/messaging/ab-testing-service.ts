import "server-only";

import { createHash } from "node:crypto";
import { getPrismaClient } from "@/lib/db/prisma";
import { LeadEventType } from "@/generated/prisma/client";

export const DEFAULT_VARIANTS = ["A", "B", "C"] as const;
export type VariantId = "A" | "B" | "C" | string;

/**
 * Deterministically and stickily assigns a lead to an A/B test variant.
 * Balanced distribution: assigns uniformly across available variants.
 */
export function assignLeadMessageVariant(
  campaignId: string,
  leadId: string,
  availableVariants: string[] = ["A", "B", "C"],
): string {
  if (!availableVariants || availableVariants.length === 0) {
    return "A";
  }
  if (availableVariants.length === 1) {
    return availableVariants[0];
  }

  const hash = createHash("sha256")
    .update(`${campaignId}:${leadId}:ab_variant`)
    .digest("hex");
  const num = parseInt(hash.slice(0, 8), 16);
  const index = Math.abs(num) % availableVariants.length;
  return availableVariants[index];
}

export type SignificanceResult = {
  zScore: number;
  pValueEstimate: number;
  significance: "high" | "medium" | "low" | "not_significant" | "not_enough_data";
  label: string;
};

/**
 * Two-proportion z-test to determine if variant B is statistically significantly
 * different from variant A.
 *
 * Enforces statistical honesty: if either n < 30, flags "not_enough_data".
 */
export function calculateTwoProportionZTest(
  nA: number,
  successA: number,
  nB: number,
  successB: number,
): SignificanceResult {
  if (nA < 30 || nB < 30) {
    return {
      zScore: 0,
      pValueEstimate: 1,
      significance: "not_enough_data",
      label: "Not enough data (min n=30 per variant)",
    };
  }

  const pA = successA / nA;
  const pB = successB / nB;

  const pooledP = (successA + successB) / (nA + nB);
  if (pooledP <= 0 || pooledP >= 1) {
    return {
      zScore: 0,
      pValueEstimate: 1,
      significance: "not_significant",
      label: "No difference",
    };
  }

  const standardError = Math.sqrt(
    pooledP * (1 - pooledP) * (1 / nA + 1 / nB),
  );

  if (standardError === 0) {
    return {
      zScore: 0,
      pValueEstimate: 1,
      significance: "not_significant",
      label: "No difference",
    };
  }

  const z = (pB - pA) / standardError;
  const absZ = Math.abs(z);

  let pVal = 0.5;
  let significance: SignificanceResult["significance"] = "not_significant";
  let label = "No significant difference";

  if (absZ >= 2.576) {
    pVal = 0.01;
    significance = "high";
    label = "99% Confidence (Statistically Significant)";
  } else if (absZ >= 1.96) {
    pVal = 0.05;
    significance = "medium";
    label = "95% Confidence (Statistically Significant)";
  } else if (absZ >= 1.645) {
    pVal = 0.10;
    significance = "low";
    label = "90% Confidence (Directional)";
  }

  return {
    zScore: Number(z.toFixed(3)),
    pValueEstimate: pVal,
    significance,
    label,
  };
}

export type VariantMetric = {
  variant: string;
  sent: number;
  replies: number;
  positiveReplies: number;
  replyRate: number;
  positiveRate: number;
  lowConfidence: boolean;
  significanceVsControl?: SignificanceResult;
};

/**
 * Computes A/B test variant performance metrics for a campaign from LeadEvent.
 */
export async function getCampaignVariantMetrics(
  campaignId: string,
): Promise<VariantMetric[]> {
  const prisma = getPrismaClient();

  const events = await prisma.leadEvent.findMany({
    where: {
      campaignId,
      eventType: {
        in: [
          LeadEventType.SENT,
          LeadEventType.REPLIED,
          LeadEventType.POSITIVE_REPLY,
        ],
      },
    },
    select: {
      leadId: true,
      eventType: true,
      variant: true,
    },
  });

  // Group events by variant and lead
  const variantMap = new Map<
    string,
    {
      sentLeads: Set<string>;
      repliedLeads: Set<string>;
      positiveLeads: Set<string>;
    }
  >();

  for (const ev of events) {
    const v = ev.variant || "A";
    let entry = variantMap.get(v);
    if (!entry) {
      entry = {
        sentLeads: new Set(),
        repliedLeads: new Set(),
        positiveLeads: new Set(),
      };
      variantMap.set(v, entry);
    }

    if (ev.eventType === LeadEventType.SENT) {
      entry.sentLeads.add(ev.leadId);
    } else if (ev.eventType === LeadEventType.REPLIED) {
      entry.repliedLeads.add(ev.leadId);
    } else if (ev.eventType === LeadEventType.POSITIVE_REPLY) {
      entry.positiveLeads.add(ev.leadId);
    }
  }

  const results: VariantMetric[] = [];
  const variantKeys = Array.from(variantMap.keys()).sort();

  for (const v of variantKeys) {
    const entry = variantMap.get(v)!;
    const sent = entry.sentLeads.size;
    const replies = entry.repliedLeads.size;
    const positiveReplies = entry.positiveLeads.size;
    const replyRate = sent > 0 ? Number(((replies / sent) * 100).toFixed(1)) : 0;
    const positiveRate =
      sent > 0 ? Number(((positiveReplies / sent) * 100).toFixed(1)) : 0;

    results.push({
      variant: v,
      sent,
      replies,
      positiveReplies,
      replyRate,
      positiveRate,
      lowConfidence: sent < 30,
    });
  }

  // Calculate significance against control (first variant or "A")
  const control = results.find((r) => r.variant === "A") || results[0];
  if (control) {
    for (const r of results) {
      if (r.variant === control.variant) {
        continue;
      }
      r.significanceVsControl = calculateTwoProportionZTest(
        control.sent,
        control.positiveReplies,
        r.sent,
        r.positiveReplies,
      );
    }
  }

  return results;
}
