import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { createPrismaClient } from "../src/lib/db/prisma";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3005";
const db = createPrismaClient();

let passed = 0;
let failed = 0;
function check(cond: boolean, name: string, detail?: string) {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.error(`  FAIL: ${name}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

async function registerUser(label: string): Promise<string> {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `task18b_${label}_${stamp}@example.com`,
      password: "Password123!",
      name: `Task18b ${label}`,
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no session cookie");
  return setCookie.split(";")[0];
}

async function main() {
  console.log("=================================================================");
  console.log("   TASK 18b: SENDER ACCOUNT API SECURITY / IDOR SUITE            ");
  console.log("=================================================================\n");

  const cookieA = await registerUser("a");
  const cookieB = await registerUser("b");

  // Unauthenticated
  const anon = await fetch(`${BASE_URL}/api/instagram/senders`);
  check(anon.status === 401, `unauthenticated list rejected (got ${anon.status})`);

  // Create
  console.log("\n[1] Create + response secrecy");
  const createRes = await fetch(`${BASE_URL}/api/instagram/senders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ displayName: "API Sender" }),
  });
  const createBody = (await createRes.json()) as { sender?: { id: string; status: string } };
  check(createRes.status === 201, `create returns 201 (got ${createRes.status})`);
  const senderAId = createBody.sender?.id ?? "";
  check(Boolean(senderAId), "create returns sender id");
  check(createBody.sender?.status === "CONNECTING", "new sender is CONNECTING");
  const createText = JSON.stringify(createBody);
  check(!createText.includes("sessionPath"), "API never returns sessionPath");
  check(
    !/sessionid|cookie|password|storageState/i.test(createText),
    "API never returns cookies/passwords/session state",
  );

  // Client cannot set server-managed fields
  const forgeRes = await fetch(`${BASE_URL}/api/instagram/senders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ status: "CONNECTED", sessionPath: "C:/windows", userId: "other" }),
  });
  check(forgeRes.status === 400, `client cannot forge status/sessionPath/userId (got ${forgeRes.status})`);

  // List isolation
  console.log("\n[2] Ownership / IDOR");
  const listA = await fetch(`${BASE_URL}/api/instagram/senders`, { headers: { Cookie: cookieA } });
  const listABody = (await listA.json()) as { senders: Array<{ id: string }> };
  check(
    listABody.senders.some((s) => s.id === senderAId),
    "owner sees their sender account",
  );
  const listB = await fetch(`${BASE_URL}/api/instagram/senders`, { headers: { Cookie: cookieB } });
  const listBBody = (await listB.json()) as { senders: Array<{ id: string }> };
  check(listBBody.senders.length === 0, "other user's list does not include the sender");

  const getAsB = await fetch(`${BASE_URL}/api/instagram/senders/${senderAId}`, {
    headers: { Cookie: cookieB },
  });
  check(getAsB.status === 404, `other user cannot GET sender (got ${getAsB.status})`);

  const verifyAsB = await fetch(`${BASE_URL}/api/instagram/senders/${senderAId}/verify`, {
    method: "POST",
    headers: { Cookie: cookieB },
  });
  check(verifyAsB.status === 404, `other user cannot verify sender (got ${verifyAsB.status})`);

  const connectAsB = await fetch(`${BASE_URL}/api/instagram/senders/${senderAId}/connect`, {
    method: "POST",
    headers: { Cookie: cookieB },
  });
  check(connectAsB.status === 404, `other user cannot connect sender (got ${connectAsB.status})`);

  const disconnectAsB = await fetch(`${BASE_URL}/api/instagram/senders/${senderAId}/disconnect`, {
    method: "POST",
    headers: { Cookie: cookieB },
  });
  check(disconnectAsB.status === 404, `other user cannot disconnect sender (got ${disconnectAsB.status})`);

  const cancelAsB = await fetch(`${BASE_URL}/api/instagram/senders/${senderAId}/cancel`, {
    method: "POST",
    headers: { Cookie: cookieB },
  });
  check(cancelAsB.status === 404, `other user cannot cancel sender login (got ${cancelAsB.status})`);

  const cancelAnon = await fetch(`${BASE_URL}/api/instagram/senders/${senderAId}/cancel`, {
    method: "POST",
  });
  check(cancelAnon.status === 401, `unauthenticated cancel rejected (got ${cancelAnon.status})`);

  // Sender id in message payload is ownership-validated (owned lead, foreign sender)
  console.log("\n[3] Dispatch payload ownership");
  const campaignB = await (async () => {
    const res = await fetch(`${BASE_URL}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieB },
      body: JSON.stringify({ name: `Task18b Campaign ${Date.now()}`, leadLimit: 5 }),
    });
    return (await res.json()) as { id: string };
  })();
  const prisma = db;
  const leadB = await prisma.lead.create({
    data: {
      campaignId: campaignB.id,
      username: `task18b_lead_${Date.now()}`,
      profileUrl: "https://www.instagram.com/task18b_lead/",
    },
  });
  const crossSend = await fetch(`${BASE_URL}/api/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieB },
    body: JSON.stringify({
      campaignId: campaignB.id,
      leadId: leadB.id,
      message: "cross tenant sender attempt",
      senderAccountId: senderAId,
    }),
  });
  check(crossSend.status === 404, `foreign senderAccountId rejected on dispatch (got ${crossSend.status})`);
  await db.$disconnect();

  // DM composer diagnostic endpoint: ownership + input validation (no browser).
  console.log("\n[4c] DM composer diagnostic security");
  const diagAnon = await fetch(
    `${BASE_URL}/api/instagram/senders/${senderAId}/diagnose-dm`,
    { method: "POST" },
  );
  check(diagAnon.status === 401, `unauthenticated diagnose rejected (got ${diagAnon.status})`);

  const diagAsB = await fetch(`${BASE_URL}/api/instagram/senders/${senderAId}/diagnose-dm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieB },
    body: JSON.stringify({ username: "instagram" }),
  });
  check(diagAsB.status === 404, `other user cannot diagnose sender (got ${diagAsB.status})`);

  const diagMissingTarget = await fetch(
    `${BASE_URL}/api/instagram/senders/${senderAId}/diagnose-dm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({}),
    },
  );
  check(diagMissingTarget.status === 400, `missing target rejected (got ${diagMissingTarget.status})`);

  const diagBadHost = await fetch(
    `${BASE_URL}/api/instagram/senders/${senderAId}/diagnose-dm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ profileUrl: "https://evil.example.com/not-instagram" }),
    },
  );
  check(diagBadHost.status === 400, `non-instagram target host rejected (got ${diagBadHost.status})`);

  // Sender is still CONNECTING here: valid target must be rejected without a launch.
  const diagNotConnected = await fetch(
    `${BASE_URL}/api/instagram/senders/${senderAId}/diagnose-dm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      body: JSON.stringify({ username: "instagram" }),
    },
  );
  const diagNotConnectedBody = (await diagNotConnected.json()) as {
    error?: { code?: string };
  };
  check(
    diagNotConnected.status === 400 && diagNotConnectedBody.error?.code === "SESSION_UNAVAILABLE",
    `non-connected sender diagnose rejected (got ${diagNotConnected.status}/${diagNotConnectedBody.error?.code})`,
  );

  // Owner cancel (no interactive browser was launched, so this is safe/fast).
  console.log("\n[4b] Owner cancels pending login");
  const cancelOwn = await fetch(`${BASE_URL}/api/instagram/senders/${senderAId}/cancel`, {
    method: "POST",
    headers: { Cookie: cookieA },
  });
  const cancelOwnBody = (await cancelOwn.json()) as { sender?: { status: string } };
  check(
    cancelOwn.status === 200 && cancelOwnBody.sender?.status === "AUTH_REQUIRED",
    `owner cancel returns AUTH_REQUIRED (got ${cancelOwn.status}/${cancelOwnBody.sender?.status})`,
  );

  // Owner disconnect (no browser launched)
  console.log("\n[5] Owner disconnect");
  const disconnectRes = await fetch(`${BASE_URL}/api/instagram/senders/${senderAId}/disconnect`, {
    method: "POST",
    headers: { Cookie: cookieA },
  });
  const disconnectBody = (await disconnectRes.json()) as { sender?: { status: string } };
  check(
    disconnectRes.status === 200 && disconnectBody.sender?.status === "DISCONNECTED",
    `owner can disconnect (got ${disconnectRes.status}/${disconnectBody.sender?.status})`,
  );

  console.log("\n=================================================================");
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log("=================================================================");
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
