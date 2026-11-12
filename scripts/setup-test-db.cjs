/* eslint-disable */
/**
 * Creates the test database if it does not exist, and applies all Prisma migrations to it.
 * Usage: npm run test:db:setup
 */
const { execSync } = require("node:child_process");
const { Client } = require("pg");
const { getTestDatabaseUrl, extractDatabaseName, assertSafeTestDatabase } = require("./test_db_guard.cjs");

async function setupTestDb() {
  const testDbUrl = getTestDatabaseUrl();
  assertSafeTestDatabase(testDbUrl);

  const dbName = extractDatabaseName(testDbUrl);
  console.log(`Setting up test database: ${dbName}...`);

  // Connect to postgres maintenance DB to check/create test DB
  const maintenanceUrl = new URL(testDbUrl);
  maintenanceUrl.pathname = "/postgres";

  const client = new Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();

  try {
    const res = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (res.rowCount === 0) {
      console.log(`Creating database "${dbName}"...`);
      // Database names cannot be parameterized in CREATE DATABASE
      const safeIdentifier = dbName.replace(/"/g, '""');
      await client.query(`CREATE DATABASE "${safeIdentifier}";`);
      console.log(`Database "${dbName}" created.`);
    } else {
      console.log(`Database "${dbName}" already exists.`);
    }
  } finally {
    await client.end();
  }

  // Run prisma migrate deploy targeting test database
  console.log(`Applying migrations to "${dbName}"...`);
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: testDbUrl,
    },
  });

  console.log(`\nTest database "${dbName}" is ready and fully migrated!`);
}

setupTestDb().catch((err) => {
  console.error("Test DB setup failed:", err);
  process.exit(1);
});

