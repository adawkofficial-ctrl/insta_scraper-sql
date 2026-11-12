import dotenv from "dotenv";
dotenv.config();

import bcrypt from "bcryptjs";
import { getPrismaClient } from "../src/lib/db/prisma";

async function upsertAdminUser(
  prisma: ReturnType<typeof getPrismaClient>,
  email: string,
  passwordHash: string,
  name: string,
) {
  const existingUser = await prisma.user.findUnique({
    where: { email },
  });

  if (existingUser) {
    await prisma.user.update({
      where: { id: existingUser.id },
      data: {
        role: "ADMIN",
        passwordHash,
        name,
      },
    });
    console.log(`Admin user [${email}] successfully updated.`);
  } else {
    await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        role: "ADMIN",
      },
    });
    console.log(`Admin user [${email}] successfully created.`);
  }
}

async function main() {
  const prisma = getPrismaClient();
  try {
    console.log("Ensuring 'role' column exists in 'User' table...");
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'USER';
    `);
    console.log("Database schema confirmed.");

    const adminPassword = process.env.ADMIN_PASSWORD || "AdminPass2026!Secure";
    const passwordHash = await bcrypt.hash(adminPassword, 12);

    const accounts = [
      {
        email: (process.env.ADMIN_EMAIL || "admin@instascraper.com").toLowerCase(),
        name: "System Administrator",
      },
      {
        email: "admin@admin.com",
        name: "Administrator",
      },
    ];

    for (const acc of accounts) {
      await upsertAdminUser(prisma, acc.email, passwordHash, acc.name);
    }

    console.log("\n==========================================");
    console.log("DEFAULT ADMIN ACCOUNT(S) READY IN DB:");
    console.log(`Primary Email:   admin@instascraper.com`);
    console.log(`Secondary Email: admin@admin.com`);
    console.log(`Password:        ${adminPassword}`);
    console.log(`Role:            ADMIN`);
    console.log("==========================================\n");
  } catch (error) {
    console.error("Failed to seed admin account:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
