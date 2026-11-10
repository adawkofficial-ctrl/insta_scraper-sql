/**
 * Stage 4: chainDetection
 * Detects corporate chains, franchises, and multi-location businesses.
 * Prunes chains if campaign.excludeChains !== false.
 */

import type { DiscoveredCandidate } from "../../discovery-provider";
import { detectChains } from "../../chain-detector";
import type { DiscoveryDependencies, PipelineStageContext, RejectionDetail, StageResult } from "../types";

export interface ChainDetectionInput {
  candidates: DiscoveredCandidate[];
  minOccurrencesForChain?: number;
}

export async function chainDetectionStage(
  input: ChainDetectionInput,
  context: PipelineStageContext,
  deps: DiscoveryDependencies = {},
): Promise<StageResult<DiscoveredCandidate>> {
  const start = deps.now ? deps.now() : Date.now();
  const survivors: DiscoveredCandidate[] = [];
  const rejected: RejectionDetail[] = [];
  const counters: Record<string, number> = {
    chainsDetected: 0,
    chainsExcluded: 0,
  };

  const chainResults = detectChains(input.candidates, {
    minOccurrencesForChain: input.minOccurrencesForChain ?? 3,
  });

  const shouldExclude = context.campaign.excludeChains !== false;

  for (const candidate of input.candidates) {
    const chainRes = chainResults.get(candidate);
    candidate.isChain = chainRes?.isChain ?? false;

    if (candidate.isChain) {
      counters.chainsDetected++;
      if (shouldExclude) {
        counters.chainsExcluded++;
        rejected.push({
          id: candidate.username ?? candidate.gmapsPlaceId ?? candidate.fullName ?? "unknown",
          reason: "CHAIN_EXCLUDED",
          detail: chainRes?.reason ?? "Corporate chain / franchise detected",
          gate: "chainDetection",
          matchedTerm: chainRes?.matchedPattern || chainRes?.reason,
        });
        continue;
      }
    }

    survivors.push(candidate);
  }

  const durationMs = (deps.now ? deps.now() : Date.now()) - start;

  return {
    survivors,
    rejected,
    spendUsd: 0,
    counters,
    durationMs,
  };
}
