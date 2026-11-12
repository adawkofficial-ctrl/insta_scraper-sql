/* eslint-disable */
const Module = require("module");
try {
  const resolved = require.resolve("server-only");
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {},
  };
} catch {}
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "server-only" || (typeof id === "string" && id.includes("server-only"))) {
    return {};
  }
  return orig.apply(this, arguments);
};

const { assertSafeTestDatabase } = require("./test_db_guard.cjs");
if (process.env.DATABASE_URL || process.env.DATABASE_URL_TEST) {
  assertSafeTestDatabase();
}

