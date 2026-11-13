import "server-only";

import { ApifyClient } from "apify-client";

import { getServerEnv } from "@/lib/env";

import { ProviderError } from "../provider-error";

const APIFY_API_TOKEN_ENV = "APIFY_API_TOKEN";

let client: ApifyClient | null = null;

/**
 * Shared server-side Apify client. Reused by the profile enrichment provider and
 * the discovery provider so the token is only ever read server-side.
 */
export function getApifyClient(): ApifyClient {
  if (client === null) {
    const token = getServerEnv(APIFY_API_TOKEN_ENV);
    if (token === undefined) {
      throw new ProviderError(
        "apify",
        "getClient",
        `Missing required server environment variable: ${APIFY_API_TOKEN_ENV}`,
        { code: "missing_credentials" },
      );
    }

    client = new ApifyClient({ token });
  }

  return client;
}

let isMockClientSet = false;

export function setApifyClientForTesting(mockClient: ApifyClient | null): void {
  if (process.env.NODE_ENV !== "test") {
    // Fail loud instead of silently falling through to the live Apify client.
    throw new Error(
      "setApifyClientForTesting is test-only and requires NODE_ENV=test. Refusing to install a mock outside tests.",
    );
  }
  client = mockClient;
  isMockClientSet = mockClient !== null;
}

export function hasMockApifyClient(): boolean {
  return isMockClientSet;
}
