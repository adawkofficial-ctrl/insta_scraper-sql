// Prisma 7 CLI configuration. The CLI reads DATABASE_URL from the environment,
// which this file loads from .env via dotenv. Never imported by application code.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
