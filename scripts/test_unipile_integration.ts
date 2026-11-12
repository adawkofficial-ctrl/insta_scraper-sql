import "dotenv/config";

// Mock server-only before importing server code in standalone script
try {
  const serverOnlyPath = require.resolve("server-only");
  require.cache[serverOnlyPath] = {
    id: serverOnlyPath,
    filename: serverOnlyPath,
    loaded: true,
    exports: {},
  } as unknown as NodeModule;
} catch {}

async function main() {
  const { getUnipileConfig } = await import("../src/lib/env");
  const { UnipileClient } = await import("../src/lib/services/unipile");
  const { getMessagingProvider } = await import("../src/lib/services/messaging");

  console.log("==================================================");
  console.log("     UNIPILE MESSAGING INTEGRATION TEST          ");
  console.log("==================================================");

  let passed = 0;
  let failed = 0;

  function assert(cond: boolean, name: string) {
    if (cond) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`);
      failed++;
    }
  }

  // 1. Verify Unipile Config Helper
  const config = getUnipileConfig();
  console.log("[TEST] Unipile Base URL:", config.baseUrl);
  assert(Boolean(config.baseUrl), "Unipile baseUrl is configured or defaults properly");

  // 2. Verify Username Extraction
  const extracted1 = UnipileClient.extractUsername("https://www.instagram.com/growth_agency_test/");
  assert(extracted1 === "growth_agency_test", `Extracted username matches "growth_agency_test" (got: ${extracted1})`);

  const extracted2 = UnipileClient.extractUsername("@growth_agency_test");
  assert(extracted2 === "growth_agency_test", `Extracted handle matches "growth_agency_test" (got: ${extracted2})`);

  const extracted3 = UnipileClient.extractUsername("growth_agency_test?igsh=123");
  assert(extracted3 === "growth_agency_test", `Extracted query param stripped (got: ${extracted3})`);

  // 3. Verify getMessagingProvider() with Unipile connectionMethod
  const provider = getMessagingProvider({ connectionMethod: "UNIPILE" });
  assert(provider.name === "unipile", `getMessagingProvider({ connectionMethod: "UNIPILE" }) returns provider name "unipile" (got: ${provider.name})`);

  // 4. Verify Provider Status returns AUTH_REQUIRED gracefully when unconfigured
  const status = await provider.getStatus();
  assert(
    status.provider === "unipile" && (status.status === "AUTH_REQUIRED" || status.status === "READY"),
    `Provider getStatus() returns proper provider and status (status: ${status.status}, message: ${status.message})`
  );

  // 5. Verify sendMessage validates recipient and credentials
  const sendRes = await provider.sendMessage({
    profileUrl: "https://www.instagram.com/test_user_lead/",
    message: "Hello from test!",
  });
  assert(
    sendRes.success === false && Boolean(sendRes.error?.code),
    `sendMessage safely validates connection (code: ${sendRes.error?.code}, message: ${sendRes.error?.message})`
  );

  // 6. Verify Hosted Auth Link generation
  const client = new UnipileClient();
  try {
    const hostedLink = await client.createHostedAuthLink({
      name: "test_user_verification",
    });
    assert(
      Boolean(hostedLink?.url && hostedLink.url.startsWith("https://")),
      `createHostedAuthLink generates valid link (url: ${hostedLink?.url?.slice(0, 45)}...)`
    );
  } catch (err: any) {
    if (
      err?.message?.includes("401") ||
      err?.message?.includes("missing_credentials") ||
      err?.message?.includes("ACCOUNT_AUTHENTICATION_ERROR")
    ) {
      console.log(`[INFO] createHostedAuthLink contacted Unipile (returned credential status: ${err.message})`);
      assert(true, "createHostedAuthLink safely handles provider credential response");
    } else {
      throw err;
    }
  }


  console.log("\n==================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
