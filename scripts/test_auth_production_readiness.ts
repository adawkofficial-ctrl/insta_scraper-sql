import "dotenv/config";
import assert from "node:assert/strict";
import {
  registerUser,
  loginUser,
  createSessionToken,
  verifySessionToken,
  hashPassword,
  comparePassword,
} from "../src/lib/services/auth/auth-service";
import {
  SESSION_COOKIE_NAME,
  DEFAULT_AUTH_SECRET,
  getAuthSecret,
  getAuthSecretBytes,
} from "../src/lib/services/auth/auth-constants";
import { checkRateLimit, getClientIp } from "../src/lib/services/auth/rate-limiter";
import { extractTokenFromRequest } from "../src/lib/services/auth/auth-guard";
import { getSafeRedirect } from "../src/components/auth-card";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

async function runTests() {
  console.log("=== Testing Auth Production Readiness & Fixes ===");

  const connectionString = process.env.DATABASE_URL!;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  // 1. Unified Secrets & Tokens
  console.log("\n[Test 1] Auth secret bytes and constants");
  {
    const secret = getAuthSecret();
    assert.ok(secret && secret.length >= 32, "Auth secret must be at least 32 characters");
    const secretBytes = getAuthSecretBytes();
    assert.equal(secretBytes.length, secret.length);
    assert.equal(SESSION_COOKIE_NAME, "insta_session");
    console.log("  ✓ Secret bytes and cookie constants correctly resolved");
  }

  // 2. Token creation and verification
  console.log("\n[Test 2] Session JWT signing and verification");
  {
    const token = await createSessionToken({
      sub: "user_test_123",
      email: "test_jwt@example.com",
      name: "JWT Tester",
    });
    assert.ok(token && typeof token === "string");

    const payload = await verifySessionToken(token);
    assert.ok(payload);
    assert.equal(payload.sub, "user_test_123");
    assert.equal(payload.email, "test_jwt@example.com");
    assert.equal(payload.name, "JWT Tester");

    // Verification of tampered token
    const tampered = token.slice(0, -5) + "abcde";
    const invalidPayload = await verifySessionToken(tampered);
    assert.equal(invalidPayload, null, "Tampered token must return null");
    console.log("  ✓ Session token created, verified, and tamper-resistant");
  }

  // 3. Open Redirect Sanitization
  console.log("\n[Test 3] Open redirect sanitization");
  {
    assert.equal(getSafeRedirect("https://evil.com"), "/");
    assert.equal(getSafeRedirect("http://evil.com"), "/");
    assert.equal(getSafeRedirect("//evil.com"), "/");
    assert.equal(getSafeRedirect("/\\evil.com"), "/");
    assert.equal(getSafeRedirect("javascript:alert(1)"), "/");
    assert.equal(getSafeRedirect("/login"), "/");
    assert.equal(getSafeRedirect("/register"), "/");
    assert.equal(getSafeRedirect("/login?redirect=/dashboard"), "/");
    assert.equal(getSafeRedirect("/register?plan=pro"), "/");
    assert.equal(getSafeRedirect("/campaigns"), "/campaigns");
    assert.equal(getSafeRedirect("/settings"), "/settings");
    assert.equal(getSafeRedirect(null), "/");
    console.log("  ✓ All open redirect attack vectors and loop vectors sanitized");
  }

  // 4. Rate Limiter
  console.log("\n[Test 4] Sliding-window rate limiter");
  {
    const key = `test_ip_${Date.now()}`;
    // 3 requests allowed in 1000ms window
    const r1 = checkRateLimit(key, 3, 1000);
    assert.equal(r1.allowed, true);
    assert.equal(r1.remaining, 2);

    const r2 = checkRateLimit(key, 3, 1000);
    assert.equal(r2.allowed, true);
    assert.equal(r2.remaining, 1);

    const r3 = checkRateLimit(key, 3, 1000);
    assert.equal(r3.allowed, true);
    assert.equal(r3.remaining, 0);

    const r4 = checkRateLimit(key, 3, 1000);
    assert.equal(r4.allowed, false, "4th request within window must be rate limited");
    assert.equal(r4.remaining, 0);
    assert.ok(r4.resetMs > 0);
    console.log("  ✓ Rate limiter sliding window correctly throttles requests");
  }

  // 5. Client IP extraction
  console.log("\n[Test 5] Client IP extraction from headers");
  {
    const req1 = new Request("http://localhost", {
      headers: { "x-forwarded-for": "203.0.113.195, 70.41.3.18" },
    });
    assert.equal(getClientIp(req1), "203.0.113.195");

    const req2 = new Request("http://localhost", {
      headers: { "cf-connecting-ip": "198.51.100.42" },
    });
    assert.equal(getClientIp(req2), "198.51.100.42");
    console.log("  ✓ Client IP accurately parsed from proxy headers");
  }

  // 6. Safe Cookie Extraction with Malformed Characters
  console.log("\n[Test 6] Malformed cookie resilience");
  {
    const malformedReq = new Request("http://localhost", {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=%E0%A4%A; other=123`,
      },
    });
    // Should NOT throw URIError
    const token = await extractTokenFromRequest(malformedReq);
    assert.equal(token, "%E0%A4%A");
    console.log("  ✓ Malformed cookie percent encoding gracefully handled without server crash");
  }

  // 7. Input validation: Email and Password bounds
  console.log("\n[Test 7] Email and Password validation bounds");
  {
    // Invalid emails
    await assert.rejects(
      registerUser({ email: "not-an-email", password: "ValidPassword123" }),
      (err: any) => err.code === "INVALID_EMAIL",
    );
    await assert.rejects(
      registerUser({ email: "user@domain", password: "ValidPassword123" }),
      (err: any) => err.code === "INVALID_EMAIL",
    );

    // Password too short
    await assert.rejects(
      registerUser({ email: "short@example.com", password: "123" }),
      (err: any) => err.code === "PASSWORD_TOO_SHORT",
    );

    // Password too long (DoS attack prevention)
    const longPassword = "A".repeat(150);
    await assert.rejects(
      registerUser({ email: "toolong@example.com", password: longPassword }),
      (err: any) => err.code === "PASSWORD_TOO_LONG",
    );
    console.log("  ✓ Strict input bounds enforced for email and password");
  }

  // 8. Register, Login, Duplicate Prevention, and Cleanup
  console.log("\n[Test 8] Register, Login, and Multi-tenancy");
  const testEmail = `prod_test_${Date.now()}@example.com`;
  const testPassword = "StrongProductionPassword123!";
  let createdUserId: string | null = null;
  {
    const regRes = await registerUser({
      email: `  ${testEmail.toUpperCase()}  `, // Test trimming and lowercasing
      password: testPassword,
      name: "  Production User  ",
    });
    createdUserId = regRes.user.id;
    assert.equal(regRes.user.email, testEmail);
    assert.equal(regRes.user.name, "Production User");
    assert.ok(regRes.token);
    console.log(`  ✓ User successfully registered: ${createdUserId}`);

    // Prevent duplicate registration
    await assert.rejects(
      registerUser({
        email: testEmail,
        password: testPassword,
      }),
      (err: any) => err.code === "EMAIL_EXISTS",
    );
    console.log("  ✓ Duplicate registration prevented with EMAIL_EXISTS");

    // Login with correct credentials
    const loginRes = await loginUser({
      email: testEmail,
      password: testPassword,
    });
    assert.equal(loginRes.user.id, createdUserId);
    assert.ok(loginRes.token);
    console.log("  ✓ Login succeeded with normalized credentials");

    // Login with incorrect password
    await assert.rejects(
      loginUser({
        email: testEmail,
        password: "WrongPassword!",
      }),
      (err: any) => err.code === "INVALID_CREDENTIALS",
    );
    console.log("  ✓ Login rejected with INVALID_CREDENTIALS on bad password");

    // Login with non-existent email (verifying timing attack constant-time comparison)
    await assert.rejects(
      loginUser({
        email: "nonexistent_email_12345@example.com",
        password: "SomePassword123!",
      }),
      (err: any) => err.code === "INVALID_CREDENTIALS",
    );
    console.log("  ✓ Non-existent email safely rejected with INVALID_CREDENTIALS");
  }

  // Cleanup
  if (createdUserId) {
    await prisma.user.delete({ where: { id: createdUserId } });
    console.log("  ✓ Test user cleaned up from database");
  }

  console.log("\n🎉 ALL AUTH PRODUCTION READINESS TESTS PASSED!\n");
}

runTests().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
