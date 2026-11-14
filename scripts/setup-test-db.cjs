/* eslint-disable */
/**
 * Creates the MySQL test database if it does not exist, and applies the Prisma
 * MySQL baseline migration to it.
 *
 * Local development only: Hostinger managed MySQL does not allow CREATE DATABASE,
 * so on the target the test database must be pre-created by the host and this
 * script should be run with that existing database.
 *
 * Usage: npm run test:db:setup
 */
const { execSync } = require("node:child_process");
const mariadb = require("mariadb");
const {
  getTestDatabaseUrl,
  extractDatabaseName,
  assertSafeTestDatabase,
} = require("./test_db_guard.cjs");

function parseMysqlUrl(connectionUrl) {
  const u = new URL(connectionUrl);
  return {
    host: u.hostname,
    port: u.port ? Number.parseInt(u.port, 10) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
  };
}

async function setupTestDb() {
  const testDbUrl = getTestDatabaseUrl();
  assertSafeTestDatabase(testDbUrl);

  const dbName = extractDatabaseName(testDbUrl);
  const connection = parseMysqlUrl(testDbUrl);
  console.log(
    `Setting up MySQL test database "${dbName}" on ${connection.host}:${connection.port}...`,
  );

  const admin = await mariadb.createConnection({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    connectTimeout: 10_000,
    multipleStatements: false,
  });

  try {
    try {
      const safeIdentifier = dbName.replace(/`/g, "``");
      await admin.query(
        `CREATE DATABASE IF NOT EXISTS \`${safeIdentifier}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      console.log(`Database "${dbName}" exists or was created.`);
    } catch (err) {
      const errno = err && err.errno;
      if (errno === 1044 || errno === 1045 || errno === 1142) {
        console.warn(
          `CREATE DATABASE is not permitted (MySQL error ${errno}); assuming "${dbName}" already exists.`,
        );
      } else {
        throw err;
      }
    }
  } finally {
    await admin.end();
  }

  console.log(`Applying migrations to "${dbName}"...`);
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: testDbUrl,
      DATABASE_URL_MYSQL_LOCAL: testDbUrl,
    },
  });

  console.log(`\nTest database "${dbName}" is ready and fully migrated!`);
}

setupTestDb().catch((err) => {
  console.error("Test DB setup failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
