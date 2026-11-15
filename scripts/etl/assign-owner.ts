/**
 * Idempotent cutover owner assignment.
 * Default dry-run. Add --apply to reassign migrated campaigns/profiles to the
 * configured admin user. Prints counts/ids only.
 */
import mariadb from "mariadb";
import { mysqlConnectionConfig, parseArgs } from "./common";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = typeof args.email === "string" ? args.email.trim().toLowerCase() : "";
  if (!email) throw new Error("Usage: npm run cutover:assign-owner -- --email <admin email> [--apply]");
  const targetUrl = process.env[String(args.target ?? "DATABASE_URL_MYSQL_LOCAL")];
  if (!targetUrl) throw new Error("Missing target database URL env");
  const apply = args.apply === true;
  const db = await mariadb.createConnection(mysqlConnectionConfig(targetUrl));
  try {
    const admin = (await db.query("SELECT id FROM `User` WHERE LOWER(email)=? LIMIT 1", [email]))[0];
    if (!admin) throw new Error("Admin user not found; run the admin seed first.");
    const adminId = String(admin.id);
    const profiles = (await db.query("SELECT id FROM `CompanyProfile` WHERE `userId`=? ORDER BY `isDefault` DESC, `createdAt` ASC LIMIT 1", [adminId])) as Array<{ id: string }>;
    let profileId = profiles[0]?.id ? String(profiles[0].id) : null;
    const campaigns = (await db.query("SELECT id FROM `Campaign` WHERE `userId`<>? ORDER BY `createdAt` ASC", [adminId])) as Array<{ id: string }>;
    console.log(`admin=${adminId} profile=${profileId ?? "<none>"} campaigns_to_assign=${campaigns.length} mode=${apply ? "APPLY" : "dry-run"}`);
    if (!apply || campaigns.length === 0) return;
    if (!profileId) {
      profileId = `cutover_${adminId}`.slice(0, 191);
      await db.query("INSERT INTO `CompanyProfile` (`id`,`userId`,`name`,`isDefault`,`createdAt`,`updatedAt`) VALUES (?,?,?,?,NOW(3),NOW(3))", [profileId, adminId, "Cutover Admin Co", 1]);
    }
    for (const campaign of campaigns) {
      await db.query("UPDATE `Campaign` SET `userId`=?, `companyProfileId`=? WHERE `id`=?", [adminId, profileId, campaign.id]);
    }
    console.log(`assigned_campaigns=${campaigns.length}`);
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error("assign-owner failed:", e instanceof Error ? e.message : String(e)); process.exit(1); });
