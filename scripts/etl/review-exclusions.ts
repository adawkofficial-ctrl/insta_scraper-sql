/**
 * Read-only exclusions review. Writes docs/ETL_EXCLUSIONS_REVIEW.md.
 * No personal data: email domain only, no lead names/messages/bodies.
 */
import fs from "node:fs";
import path from "node:path";
import { Client as PgClient } from "pg";
import { buildExclusions, isExcluded, type Row } from "./common";

const TABLES = ["User", "CompanyProfile", "Campaign", "Lead", "Message", "InstagramSenderAccount", "EmailSenderAccount", "DoNotContact", "OutboundSendIdempotency", "FollowUpMessage", "CampaignExecution"];

async function main() {
  const url = process.env[process.argv[2] || "SOURCE_PG_URL"];
  if (!url) throw new Error("Missing source URL env");
  const client = new PgClient({ connectionString: url });
  await client.connect();
  const source: Record<string, Row[]> = {};
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    for (const table of TABLES) {
      try { source[table] = (await client.query(`SELECT * FROM "${table}"`)).rows as Row[]; }
      catch { source[table] = []; }
    }
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }

  const ex = buildExclusions(source);
  const leadsByCampaign = new Map<string, Row[]>();
  for (const lead of source.Lead ?? []) {
    const id = String(lead.campaignId);
    const rows = leadsByCampaign.get(id) ?? [];
    rows.push(lead);
    leadsByCampaign.set(id, rows);
  }
  const messagesByCampaign = new Map<string, Row[]>();
  for (const message of source.Message ?? []) {
    const id = String(message.campaignId);
    const rows = messagesByCampaign.get(id) ?? [];
    rows.push(message);
    messagesByCampaign.set(id, rows);
  }
  const dncByUser = new Map<string, number>();
  for (const d of source.DoNotContact ?? []) dncByUser.set(String(d.userId), (dncByUser.get(String(d.userId)) ?? 0) + 1);
  const idemByCampaign = new Map<string, number>();
  for (const i of source.OutboundSendIdempotency ?? []) idemByCampaign.set(String(i.campaignId), (idemByCampaign.get(String(i.campaignId)) ?? 0) + 1);
  const followByCampaign = new Map<string, number>();
  for (const f of source.FollowUpMessage ?? []) followByCampaign.set(String(f.campaignId), (followByCampaign.get(String(f.campaignId)) ?? 0) + 1);

  const lines: string[] = [];
  lines.push("# ETL Exclusions Review (Phase 4)");
  lines.push("");
  lines.push("Source: read-only PostgreSQL. Counts/ids only; user email domain only. No exclusion rules changed.");
  lines.push("");
  lines.push("## Excluded campaigns");
  lines.push("");
  lines.push("| id | name | createdAt | status | leads | messages | DNC-dependent users | idempotency | follow-ups | flags |");
  lines.push("|---|---|---|---|---:|---:|---:|---:|---:|---|");
  const excludedCampaigns = (source.Campaign ?? []).filter((c) => ex.campaigns.has(String(c.id)));
  for (const c of excludedCampaigns) {
    const leads = leadsByCampaign.get(String(c.id)) ?? [];
    const messages = messagesByCampaign.get(String(c.id)) ?? [];
    const realLeads = leads.filter((l) => !/sample|test/i.test(String(l.source ?? "")) && !String(l.username ?? "").toLowerCase().startsWith("sample_")).length;
    const flags: string[] = [];
    const cleanName = String(c.name ?? "").replace(/[^\x20-\x7E]/g, "?");
    if (messages.length > 0) flags.push("HAS_MESSAGES");
    if (realLeads > 0) flags.push("HAS_NON_SAMPLE_LEADS");
    if (!/test|campaign a|sample/i.test(String(c.name ?? ""))) flags.push("UNUSUAL_NAME");
    lines.push(`| ${c.id} | ${cleanName.replace(/\|/g, "/")} | ${new Date(String(c.createdAt)).toISOString()} | ${c.status} | ${leads.length} | ${messages.length} | ${dncByUser.get(String(c.userId)) ?? 0} | ${idemByCampaign.get(String(c.id)) ?? 0} | ${followByCampaign.get(String(c.id)) ?? 0} | ${flags.join(", ") || "none"} |`);
  }

  lines.push("");
  lines.push("## Excluded users");
  lines.push("");
  lines.push("| id | email domain | createdAt | role |");
  lines.push("|---|---|---|---|");
  const excludedUsers = (source.User ?? []).filter((u) => ex.users.has(String(u.id)));
  for (const u of excludedUsers) {
    const domain = String(u.email ?? "").split("@")[1] ?? "unknown";
    lines.push(`| ${u.id} | ${domain} | ${new Date(String(u.createdAt)).toISOString()} | ${u.role} |`);
  }

  lines.push("");
  lines.push("## Excluded sender accounts");
  lines.push("");
  lines.push("| id | status | hasSessionPath |");
  lines.push("|---|---|---|");
  const excludedSenders = [...(source.InstagramSenderAccount ?? []), ...(source.EmailSenderAccount ?? [])].filter((s) => ex.senders.has(String(s.id)));
  for (const s of excludedSenders) {
    lines.push(`| ${s.id} | ${s.status} | ${Boolean(s.sessionPath)} |`);
  }

  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Excluded campaigns: ${excludedCampaigns.length}`);
  lines.push(`- Excluded users: ${excludedUsers.length}`);
  lines.push(`- Excluded sender accounts: ${excludedSenders.length}`);
  lines.push(`- Excluded leads: ${ex.leads.size}`);
  lines.push(`- Excluded DNC rows: ${(source.DoNotContact ?? []).filter((r) => isExcluded("DoNotContact", r, ex)).length}`);

  const out = path.join(process.cwd(), "docs", "ETL_EXCLUSIONS_REVIEW.md");
  fs.writeFileSync(out, lines.join("\n"), "utf8");
  console.log(`Wrote ${out}: campaigns=${excludedCampaigns.length} users=${excludedUsers.length} senders=${excludedSenders.length}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
