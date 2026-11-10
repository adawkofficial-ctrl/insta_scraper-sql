/**
 * Stage 6: handleDiscovery
 * Routes candidates into Instagram handle candidates (for profile enrichment)
 * and multi-channel candidates (retained without IG if they have email/phone/website).
 * Places with NO contact channels whatsoever are pruned here.
 */

import type { DiscoveredCandidate } from "../../discovery-provider";
import type { DiscoveryDependencies, PipelineStageContext, RejectionDetail, StageResult } from "../types";

export interface HandleRoutingOutput {
  igCandidates: DiscoveredCandidate[];
  multiChannelCandidates: DiscoveredCandidate[];
}

export interface HandleDiscoveryInput {
  candidates: DiscoveredCandidate[];
}

export async function handleDiscoveryStage(
  input: HandleDiscoveryInput,
  context: PipelineStageContext,
  deps: DiscoveryDependencies = {},
): Promise<StageResult<HandleRoutingOutput>> {
  const start = deps.now ? deps.now() : Date.now();
  const igCandidates: DiscoveredCandidate[] = [];
  const multiChannelCandidates: DiscoveredCandidate[] = [];
  const rejected: RejectionDetail[] = [];
  const counters: Record<string, number> = {
    withIg: 0,
    multiChannelKept: 0,
    noContactDropped: 0,
    duplicateSkipped: 0,
  };

  const seenPlaceIds = new Set<string>();
  const seenDomains = new Set<string>();
  const seenPhones = new Set<string>();

  for (const candidate of input.candidates) {
    if (candidate.username) {
      counters.withIg++;
      igCandidates.push(candidate);
      continue;
    }

    // Check if candidate has ANY alternative contact channels
    const hasAnyChannel =
      (candidate.availableChannels && candidate.availableChannels.length > 0) ||
      Boolean(candidate.email || candidate.phone || candidate.website);

    if (!hasAnyChannel) {
      counters.noContactDropped++;
      rejected.push({
        id: candidate.gmapsPlaceId ?? candidate.fullName ?? "unknown",
        reason: "NO_CONTACT_CHANNELS",
        detail: "No Instagram handle, email, phone, or website available",
        gate: "handleDiscovery",
      });
      continue;
    }

    // Deduplicate multi-channel candidate by placeId, domain, and phone
    const placeId = candidate.gmapsPlaceId;
    const domain = candidate.website ? candidate.website.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase() : null;
    const phone = candidate.phone;

    if (placeId && (seenPlaceIds.has(placeId) || context.caches.existingPlaceIds.has(placeId))) {
      counters.duplicateSkipped++;
      continue;
    }
    if (domain && (seenDomains.has(domain) || context.caches.existingDomains.has(domain))) {
      counters.duplicateSkipped++;
      continue;
    }
    if (phone && (seenPhones.has(phone) || context.caches.existingPhones.has(phone))) {
      counters.duplicateSkipped++;
      continue;
    }

    if (placeId) seenPlaceIds.add(placeId);
    if (domain) seenDomains.add(domain);
    if (phone) seenPhones.add(phone);

    counters.multiChannelKept++;
    multiChannelCandidates.push(candidate);
  }

  const durationMs = (deps.now ? deps.now() : Date.now()) - start;

  return {
    survivors: [{ igCandidates, multiChannelCandidates }],
    rejected,
    spendUsd: 0,
    counters,
    durationMs,
  };
}
