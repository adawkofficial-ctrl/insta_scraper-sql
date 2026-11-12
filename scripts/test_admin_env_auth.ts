import "dotenv/config";

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

async function main() {
  console.log("==================================================");
  console.log("       ADMIN ENV CREDENTIALS TEST SUITE           ");
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

  const { getAdminCredentials } = await import("../src/lib/env");
  const { ensureAdminUser, loginUser } = await import("../src/lib/services/auth");
  const { getPrismaClient } = await import("../src/lib/db/prisma");
  const prisma = getPrismaClient();

  // 1. Verify getAdminCredentials reads from environment
  const creds = getAdminCredentials();
  assert(Boolean(creds.email && creds.password), `Admin credentials read from env (email: ${creds.email})`);

  // 2. Test ensureAdminUser creates or updates the admin
  const adminUser = await ensureAdminUser();
  assert(adminUser.email === creds.email, `ensureAdminUser returned correct email (${adminUser.email})`);
  assert(adminUser.role === "ADMIN", `ensureAdminUser has ADMIN role (${adminUser.role})`);

  const dbUser = await prisma.user.findUnique({
    where: { email: creds.email },
  });
  assert(Boolean(dbUser && dbUser.role === "ADMIN"), "Admin user confirmed in PostgreSQL database");

  // 3. Test loginUser succeeds with configured credentials
  const loginResult = await loginUser({
    email: creds.email,
    password: creds.password,
  });
  assert(Boolean(loginResult.token && loginResult.user.id), "loginUser succeeded with admin credentials from env");
  assert(loginResult.user.role === "ADMIN", "Logged in user has ADMIN role in session");

  // 4. Test loginUser rejects invalid password
  let threwExpected = false;
  try {
    await loginUser({
      email: creds.email,
      password: "WrongPassword123!",
    });
  } catch (err: any) {
    threwExpected = err?.code === "INVALID_CREDENTIALS";
  }
  assert(threwExpected, "loginUser rejects incorrect password for admin account");

  console.log("\n==================================================");
  console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
