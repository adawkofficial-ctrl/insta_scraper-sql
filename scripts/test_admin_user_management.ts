import "dotenv/config";
import assert from "node:assert/strict";

// Mock server-only before importing
try {
  const serverOnlyPath = require.resolve("server-only");
  require.cache[serverOnlyPath] = {
    id: serverOnlyPath,
    filename: serverOnlyPath,
    loaded: true,
    exports: {},
  } as unknown as NodeModule;
} catch {}

async function runTests() {
  console.log("=== Testing Admin Account & User Management ===");
  const { loginUser, registerUser, getUserById, verifySessionToken } = await import(
    "../src/lib/services/auth/auth-service"
  );
  const { requireAdmin } = await import("../src/lib/services/auth/auth-guard");
  const { ForbiddenError, ConflictError, BadRequestError } = await import("../src/lib/errors");
  const { getPrismaClient } = await import("../src/lib/db/prisma");
  const prisma = getPrismaClient();

  const adminEmail = process.env.ADMIN_EMAIL || "admin@instascraper.com";
  const adminPassword = process.env.ADMIN_PASSWORD || "AdminPass2026!Secure";

  // 1. Admin login and credentials verification
  console.log("\n[Test 1] Admin login with configured credentials");
  const { user: adminUser, token: adminToken } = await loginUser({
    email: adminEmail,
    password: adminPassword,
  });

  assert.ok(adminUser, "Admin user must exist");
  assert.equal(adminUser.email, adminEmail.toLowerCase(), "Admin email must match");
  assert.equal(adminUser.role, "ADMIN", "Admin user role must be ADMIN");
  assert.ok(adminToken, "Admin session token must be generated");

  const sessionPayload = await verifySessionToken(adminToken);
  assert.ok(sessionPayload, "Session payload must be verified");
  assert.equal(sessionPayload.role, "ADMIN", "Session payload must carry ADMIN role");
  console.log("  ✓ Admin login verified with correct role and JWT payload");

  // 2. Admin authorization guard
  console.log("\n[Test 2] requireAdmin authorization checks");
  const fakeAdminReq = new Request("http://localhost:3005/api/admin/users", {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const authedAdmin = await requireAdmin(fakeAdminReq);
  assert.equal(authedAdmin.id, adminUser.id, "Admin user must pass requireAdmin");
  console.log("  ✓ requireAdmin passes for ADMIN role");

  // Create a temporary regular user to test rejection
  const tempUserEmail = `standard_${Date.now()}@example.com`;
  const { user: standardUser, token: standardToken } = await registerUser({
    email: tempUserEmail,
    password: "Password123!",
    name: "Standard User",
    role: "USER",
  });
  assert.equal(standardUser.role, "USER");

  const fakeStandardReq = new Request("http://localhost:3005/api/admin/users", {
    headers: { Authorization: `Bearer ${standardToken}` },
  });
  await assert.rejects(
    async () => {
      await requireAdmin(fakeStandardReq);
    },
    (err: unknown) => {
      assert.ok(err instanceof ForbiddenError, "Must throw ForbiddenError for non-admin");
      return true;
    },
    "requireAdmin must block standard users with 403 Forbidden"
  );
  console.log("  ✓ requireAdmin correctly blocks standard users with 403 Forbidden");

  // 3. User account provisioning by Admin
  console.log("\n[Test 3] Admin provisions a new team member account");
  const provisionedEmail = `team_member_${Date.now()}@example.com`;
  const provisionedPassword = "SecureMemberPass2026!";
  const provisionedName = "Team Member Alex";

  const { user: createdUser } = await registerUser({
    email: provisionedEmail,
    password: provisionedPassword,
    name: provisionedName,
    role: "USER",
  });

  assert.ok(createdUser.id, "Created user must have an ID");
  assert.equal(createdUser.email, provisionedEmail.toLowerCase());
  assert.equal(createdUser.name, provisionedName);
  assert.equal(createdUser.role, "USER");
  console.log("  ✓ Admin successfully provisioned new user:", provisionedEmail);

  // 4. Verify provisioned user can log in with their credentials
  console.log("\n[Test 4] Provisioned user authentication");
  const { user: loggedInUser, token: userToken } = await loginUser({
    email: provisionedEmail,
    password: provisionedPassword,
  });
  assert.equal(loggedInUser.id, createdUser.id);
  assert.equal(loggedInUser.role, "USER");
  assert.ok(userToken, "User token generated");
  console.log("  ✓ Newly created user logged in successfully");

  // 5. Duplicate account conflict prevention
  console.log("\n[Test 5] Duplicate email prevention");
  await assert.rejects(
    async () => {
      await registerUser({
        email: provisionedEmail,
        password: "AnotherPassword123!",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof ConflictError);
      return true;
    },
    "Must throw ConflictError for existing email"
  );
  console.log("  ✓ Duplicate email creation rejected with ConflictError");

  // 6. User directory query
  console.log("\n[Test 6] Admin user directory listing");
  const directoryUsers = await prisma.user.findMany({
    where: {
      email: { in: [adminEmail, tempUserEmail, provisionedEmail] },
    },
    select: { id: true, email: true, role: true },
  });
  assert.ok(directoryUsers.length >= 3, "All created users should appear in query");
  console.log("  ✓ User directory reflects provisioned accounts");

  // 7. Cleanup test data
  console.log("\n[Test 7] Cleanup temporary test users");
  await prisma.user.deleteMany({
    where: {
      email: { in: [tempUserEmail, provisionedEmail] },
    },
  });
  console.log("  ✓ Cleaned up temporary test users");

  console.log("\nPASSED: 7 | FAILED: 0");
  console.log("🎉 ALL ADMIN & USER MANAGEMENT TESTS PASSED!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
