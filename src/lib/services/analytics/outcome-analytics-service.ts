import "server-only";

import { getPrismaClient } from "@/lib/db/prisma";
import { LeadEventType, MessageChannel, type Prisma } from "@/generated/prisma/client";
import { getCampaignVariantMetrics, type VariantMetric } from "../messaging/ab-testing-service";
import { getServerEnv } from "@/lib/env";

export type OutcomeAnalyticsFilter = {
  campaignId: string;
  startDate?: Date;
  endDate?: Date;
  channel?: MessageChannel;
};

export type FunnelMetrics = {
  places: number;
  contactable: number;
  savedLeads: number;
  sent: number;
  replied: number;
  positive: number;
  meeting: number;
  won: number;
  conversions: {
    placesToContactable: number;
    contactableToSaved: number;
    savedToSent: number;
    sentToReplied: number;
    repliedToPositive: number;
    positiveToMeeting: number;
    meetingToWon: number;
    overallSentToWon: number;
  };
};

export type CostMetrics = {
  totalDiscoverySpend: number;
  senderMonthlyFeeAllocated: number;
  totalSpend: number;
  costPerSavedLead: number;
  costPerSent: number;
  costPerReply: number;
  costPerPositiveReply: number;
  costPerMeeting: number;
  costPerWon: number;
};

export type SegmentRow = {
  segmentKey: string;
  leads: number;
  sent: number;
  replies: number;
  positiveReplies: number;
  meetings: number;
  won: number;
  replyRate: number;
  positiveRate: number;
  totalCostUsd: number;
  costPerPositiveReply: number | null;
  lowConfidence: boolean; // true if sent < 30
};

export type DataQualityPanel = {
  totalLeads: number;
  unknownFieldsCount: number;
  unknownFieldsRate: number;
  duplicateSightingsCount: number;
  duplicateRate: number;
  totalPlacesScraped: number;
  rejectedPlacesCount: number;
  enrichmentWasteRate: number;
};

export type OutcomeAnalyticsReport = {
  campaignId: string;
  funnel: FunnelMetrics;
  cost: CostMetrics;
  segments: {
    byKeyword: SegmentRow[];
    byCity: SegmentRow[];
    byTier: SegmentRow[];
    byHandleSource: SegmentRow[];
    byChainType: SegmentRow[];
    byChannel: SegmentRow[];
    byFollowerBand: SegmentRow[];
    byVariant: SegmentRow[];
  };
  dataQuality: DataQualityPanel;
  variants: VariantMetric[];
};

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0 || numerator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function safeDiv(cost: number, count: number): number {
  if (count <= 0 || cost <= 0) return 0;
  return Number((cost / count).toFixed(2));
}

function getFollowerBand(followers: number | null | undefined): string {
  if (followers == null) return "Unknown";
  if (followers < 1000) return "< 1k";
  if (followers < 5000) return "1k - 5k";
  if (followers < 20000) return "5k - 20k";
  if (followers < 100000) return "20k - 100k";
  return "100k+";
}

/**
 * Computes high-performance outcome analytics, funnel metrics, honest costs,
 * and statistical segment breakdowns without N+1 queries.
 */
export async function getCampaignOutcomeAnalytics(
  input: string | OutcomeAnalyticsFilter,
): Promise<OutcomeAnalyticsReport> {
  const prisma = getPrismaClient();
  const filter: OutcomeAnalyticsFilter =
    typeof input === "string" ? { campaignId: input } : input;
  const { campaignId, startDate, endDate, channel } = filter;

  // 1. Build date filter for events
  const eventWhere: Prisma.LeadEventWhereInput = { campaignId };
  if (channel) {
    eventWhere.channel = channel;
  }
  if (startDate || endDate) {
    eventWhere.createdAt = {};
    if (startDate) eventWhere.createdAt.gte = startDate;
    if (endDate) eventWhere.createdAt.lte = endDate;
  }

  // 2. Query ScrapeJobs for discovery places / candidates
  const scrapeJobs = await prisma.scrapeJob.findMany({
    where: { campaignId },
    select: {
      id: true,
      candidatesDiscovered: true,
      candidatesEnriched: true,
      candidatesSkipped: true,
      processedCount: true,
      costUsd: true,
    },
  });

  let totalPlacesDiscovered = 0;
  let totalCandidatesEnriched = 0;
  let totalCandidatesSkipped = 0;
  for (const job of scrapeJobs) {
    totalPlacesDiscovered += job.candidatesDiscovered || job.processedCount || 0;
    totalCandidatesEnriched += job.candidatesEnriched || 0;
    totalCandidatesSkipped += job.candidatesSkipped || 0;
  }

  // 3. Query all Leads for this campaign
  const leads = await prisma.lead.findMany({
    where: { campaignId },
    select: {
      id: true,
      discoveryKeyword: true,
      discoveryCity: true,
      city: true,
      qualityTier: true,
      handleSource: true,
      isChain: true,
      availableChannels: true,
      followersCount: true,
      followers: true,
      messageVariant: true,
      acquisitionCostUsd: true,
      email: true,
      phone: true,
      websiteDomain: true,
      instagramUsername: true,
      username: true,
      createdAt: true,
    },
  });

  // 4. Query all LeadEvents for this campaign
  const events = await prisma.leadEvent.findMany({
    where: eventWhere,
    select: {
      leadId: true,
      eventType: true,
      variant: true,
      channel: true,
      createdAt: true,
    },
  });

  // 5. Query LeadSightings for duplicate detection
  const duplicateSightingsCount = await prisma.leadSighting.count({
    where: {
      campaignId,
      matchedBy: { not: "NEW" },
    },
  });

  // 6. Map events per lead
  const leadEventsMap = new Map<string, Set<LeadEventType>>();
  for (const ev of events) {
    let set = leadEventsMap.get(ev.leadId);
    if (!set) {
      set = new Set();
      leadEventsMap.set(ev.leadId, set);
    }
    set.add(ev.eventType);
  }

  // 7. Funnel counting (unique leads per stage)
  let contactableCount = 0;
  let sentCount = 0;
  let repliedCount = 0;
  let positiveCount = 0;
  let meetingCount = 0;
  let wonCount = 0;
  let totalDiscoverySpend = 0;
  let unknownFieldsCount = 0;

  for (const lead of leads) {
    // Contactable if has any channel
    const channels = lead.availableChannels || [];
    const isContactable =
      channels.length > 0 ||
      Boolean(lead.instagramUsername || lead.username || lead.email || lead.phone);
    if (isContactable) {
      contactableCount++;
    }

    // Check unknown fields
    if (!lead.email && !lead.phone && !lead.websiteDomain && !lead.city) {
      unknownFieldsCount++;
    }

    // Sum acquisition costs
    if (lead.acquisitionCostUsd) {
      totalDiscoverySpend += Number(lead.acquisitionCostUsd);
    }

    const evSet = leadEventsMap.get(lead.id);
    if (evSet) {
      if (evSet.has(LeadEventType.SENT)) sentCount++;
      if (evSet.has(LeadEventType.REPLIED)) repliedCount++;
      if (evSet.has(LeadEventType.POSITIVE_REPLY)) positiveCount++;
      if (evSet.has(LeadEventType.MEETING_BOOKED)) meetingCount++;
      if (evSet.has(LeadEventType.WON)) wonCount++;
    }
  }

  const savedLeadsCount = leads.length;
  // If no places tracked in ScrapeJobs, fallback places to contactable or saved count
  const effectivePlaces = Math.max(totalPlacesDiscovered, contactableCount, savedLeadsCount);

  // 8. Cost calculations (including optional sender account monthly cost)
  const envMonthlyCost = parseFloat(getServerEnv("SENDER_ACCOUNT_MONTHLY_COST_USD") || "0");
  const senderMonthlyFeeAllocated = Number(
    ((envMonthlyCost > 0 ? (envMonthlyCost / 300) : 0) * sentCount).toFixed(2),
  );
  const totalSpend = Number((totalDiscoverySpend + senderMonthlyFeeAllocated).toFixed(2));

  const costMetrics: CostMetrics = {
    totalDiscoverySpend: Number(totalDiscoverySpend.toFixed(2)),
    senderMonthlyFeeAllocated,
    totalSpend,
    costPerSavedLead: safeDiv(totalSpend, savedLeadsCount),
    costPerSent: safeDiv(totalSpend, sentCount),
    costPerReply: safeDiv(totalSpend, repliedCount),
    costPerPositiveReply: safeDiv(totalSpend, positiveCount),
    costPerMeeting: safeDiv(totalSpend, meetingCount),
    costPerWon: safeDiv(totalSpend, wonCount),
  };

  const funnelMetrics: FunnelMetrics = {
    places: effectivePlaces,
    contactable: contactableCount,
    savedLeads: savedLeadsCount,
    sent: sentCount,
    replied: repliedCount,
    positive: positiveCount,
    meeting: meetingCount,
    won: wonCount,
    conversions: {
      placesToContactable: pct(contactableCount, effectivePlaces),
      contactableToSaved: pct(savedLeadsCount, contactableCount),
      savedToSent: pct(sentCount, savedLeadsCount),
      sentToReplied: pct(repliedCount, sentCount),
      repliedToPositive: pct(positiveCount, repliedCount),
      positiveToMeeting: pct(meetingCount, positiveCount),
      meetingToWon: pct(wonCount, meetingCount),
      overallSentToWon: pct(wonCount, sentCount),
    },
  };

  // 9. Aggregation function for segments
  type SegmentAccumulator = {
    segmentKey: string;
    leads: number;
    sent: number;
    replies: number;
    positiveReplies: number;
    meetings: number;
    won: number;
    totalCostUsd: number;
  };

  function buildSegmentRows(
    keyExtractor: (lead: typeof leads[0]) => string | string[] | null | undefined,
  ): SegmentRow[] {
    const accMap = new Map<string, SegmentAccumulator>();

    for (const lead of leads) {
      const rawKey = keyExtractor(lead);
      const keys = Array.isArray(rawKey)
        ? rawKey
        : [rawKey || "Unknown"];

      const evSet = leadEventsMap.get(lead.id);
      const isSent = evSet?.has(LeadEventType.SENT) ?? false;
      const isReplied = evSet?.has(LeadEventType.REPLIED) ?? false;
      const isPositive = evSet?.has(LeadEventType.POSITIVE_REPLY) ?? false;
      const isMeeting = evSet?.has(LeadEventType.MEETING_BOOKED) ?? false;
      const isWon = evSet?.has(LeadEventType.WON) ?? false;
      const leadCost = lead.acquisitionCostUsd ? Number(lead.acquisitionCostUsd) : 0;

      for (const k of keys) {
        const cleanK = (k || "Unknown").trim() || "Unknown";
        let row = accMap.get(cleanK);
        if (!row) {
          row = {
            segmentKey: cleanK,
            leads: 0,
            sent: 0,
            replies: 0,
            positiveReplies: 0,
            meetings: 0,
            won: 0,
            totalCostUsd: 0,
          };
          accMap.set(cleanK, row);
        }
        row.leads++;
        if (isSent) row.sent++;
        if (isReplied) row.replies++;
        if (isPositive) row.positiveReplies++;
        if (isMeeting) row.meetings++;
        if (isWon) row.won++;
        row.totalCostUsd += leadCost;
      }
    }

    return Array.from(accMap.values())
      .map((row) => ({
        segmentKey: row.segmentKey,
        leads: row.leads,
        sent: row.sent,
        replies: row.replies,
        positiveReplies: row.positiveReplies,
        meetings: row.meetings,
        won: row.won,
        replyRate: pct(row.replies, row.sent),
        positiveRate: pct(row.positiveReplies, row.sent),
        totalCostUsd: Number(row.totalCostUsd.toFixed(2)),
        costPerPositiveReply:
          row.positiveReplies > 0
            ? Number((row.totalCostUsd / row.positiveReplies).toFixed(2))
            : null,
        lowConfidence: row.sent < 30, // STATISTICAL HONESTY: n < 30
      }))
      .sort((a, b) => b.positiveReplies - a.positiveReplies || b.sent - a.sent);
  }

  // Segment breakdowns
  const byKeyword = buildSegmentRows((l) => l.discoveryKeyword || "General");
  const byCity = buildSegmentRows((l) => l.discoveryCity || l.city || "Unknown");
  const byTier = buildSegmentRows((l) => (l.qualityTier ? `Tier ${l.qualityTier}` : "Untiered"));
  const byHandleSource = buildSegmentRows((l) => l.handleSource || "direct");
  const byChainType = buildSegmentRows((l) => (l.isChain ? "Chain" : "Independent"));
  const byChannel = buildSegmentRows((l) =>
    l.availableChannels && l.availableChannels.length > 0
      ? l.availableChannels
      : ["INSTAGRAM"],
  );
  const byFollowerBand = buildSegmentRows((l) =>
    getFollowerBand(l.followersCount ?? l.followers),
  );
  const byVariant = buildSegmentRows((l) => (l.messageVariant ? `Variant ${l.messageVariant}` : "Variant A"));

  // 10. Data quality panel
  const totalScraped = Math.max(effectivePlaces, totalCandidatesEnriched + totalCandidatesSkipped);
  const rejectedPlacesCount = totalCandidatesSkipped;
  const enrichmentWasteRate = pct(rejectedPlacesCount, totalScraped);

  const dataQuality: DataQualityPanel = {
    totalLeads: savedLeadsCount,
    unknownFieldsCount,
    unknownFieldsRate: pct(unknownFieldsCount, savedLeadsCount),
    duplicateSightingsCount,
    duplicateRate: pct(duplicateSightingsCount, Math.max(1, savedLeadsCount + duplicateSightingsCount)),
    totalPlacesScraped: totalScraped,
    rejectedPlacesCount,
    enrichmentWasteRate,
  };

  // 11. Variant testing
  const variants = await getCampaignVariantMetrics(campaignId);

  return {
    campaignId,
    funnel: funnelMetrics,
    cost: costMetrics,
    segments: {
      byKeyword,
      byCity,
      byTier,
      byHandleSource,
      byChainType,
      byChannel,
      byFollowerBand,
      byVariant,
    },
    dataQuality,
    variants,
  };
}
