/* eslint-disable */
/**
 * Test Database Isolation Guard (MySQL port)
 * Ensures tests never connect to a production or live database.
 */

function extractDatabaseName(connectionUrl) {
  if (!connectionUrl) return "";
  try {
    const u = new URL(connectionUrl);
    return u.pathname.replace(/^\//, "").split("?")[0];
  } catch {
    const m = connectionUrl.match(/\/([^/?#]+)(\?.*)?$/);
    return m ? m[1] : "";
  }
}

function getTestDatabaseUrl() {
  if (process.env.DATABASE_URL_TEST && process.env.DATABASE_URL_TEST.trim()) {
    return process.env.DATABASE_URL_TEST.trim();
  }
  const defaultBase =
    process.env.DATABASE_URL_MYSQL_LOCAL ||
    process.env.DATABASE_URL ||
    "mysql://root:root@127.0.0.1:3306/insta_scraper_mysql_dev";
  try {
    const u = new URL(defaultBase);
    u.pathname = "/insta_scraper_mysql_test";
    return u.toString();
  } catch {
    return "mysql://root:root@127.0.0.1:3306/insta_scraper_mysql_test";
  }
}

function assertSafeTestDatabase(testDbUrl, options) {
  const dbUrl = testDbUrl || process.env.DATABASE_URL_TEST || process.env.DATABASE_URL || "";
  const dbName = extractDatabaseName(dbUrl);
  if (!dbName) {
    const msg = `FATAL: Could not determine database name from URL.`;
    if (options && options.throwOnError) throw new Error(msg);
    console.error(msg);
    process.exit(1);
  }

  // Refuse production/live names before checking the URL scheme so a
  // production Postgres URL is still rejected with the expected safety error.
  if (/prod|live/i.test(dbName)) {
    const msg = `FATAL: Refusing to run tests against production/live database: "${dbName}". Tests must run against a dedicated test database (DATABASE_URL_TEST).`;
    if (options && options.throwOnError) throw new Error(msg);
    console.error(msg);
    process.exit(1);
  }

  // Refuse if equals DATABASE_URL's DB while NODE_ENV=production.
  const prodUrl = (options && options.prodDbUrl) || process.env.ORIGINAL_DATABASE_URL || process.env.DATABASE_URL;
  const nodeEnv = (options && options.nodeEnv) || process.env.NODE_ENV;
  if (prodUrl && nodeEnv === "production") {
    const prodDbName = extractDatabaseName(prodUrl);
    if (dbName === prodDbName) {
      const msg = `FATAL: Refusing to run tests against primary database "${dbName}" while NODE_ENV=production. Tests must run against a dedicated test database (DATABASE_URL_TEST).`;
      if (options && options.throwOnError) throw new Error(msg);
      console.error(msg);
      process.exit(1);
    }
  }

  if (!/^(mysql|mariadb):\/\//i.test(dbUrl)) {
    const msg = `FATAL: mysql-port tests require a mysql:// or mariadb:// DATABASE_URL_TEST.`;
    if (options && options.throwOnError) throw new Error(msg);
    console.error(msg);
    process.exit(1);
  }

  if (!/test/i.test(dbName)) {
    const msg = `FATAL: Refusing to run tests against non-test database: "${dbName}". Use insta_scraper_mysql_test.`;
    if (options && options.throwOnError) throw new Error(msg);
    console.error(msg);
    process.exit(1);
  }

}

module.exports = {
  extractDatabaseName,
  getTestDatabaseUrl,
  assertSafeTestDatabase,
};
