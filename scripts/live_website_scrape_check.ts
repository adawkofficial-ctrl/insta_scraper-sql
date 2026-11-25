/**
 * Live website scraper check (read-only GETs to public sites, no DB writes).
 * Run: npx tsx -r ./scripts/preload_server_only.cjs scripts/live_website_scrape_check.ts [url ...]
 */
import { scrapeLeadWebsite } from "../src/lib/services/enrichment/website-lead-enricher";

const sites = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["https://canarydental.ca", "https://fairviewsmiles.ca", "https://kingeastdental.com", "https://northyorkdentist.ca"];

async function main() {
  for (const website of sites) {
    const t = Date.now();
    const r = await scrapeLeadWebsite({ website, countryCode: "CA" }, { timeoutMs: 12_000 });
    const b = r.business;
    console.log(`\n=== ${website} (${Date.now() - t} ms)`);
    console.log(`pages: ${r.pages.map((p) => `${new URL(p.url).pathname}=${p.ok ? "ok" : p.error ?? p.status}`).join("  ")}`);
    console.log(`instagram: ${r.handle ?? "-"} | emails: ${r.emails.map((e) => e.value).join(", ") || "-"} | phones: ${r.phones.map((p) => p.normalized).join(", ") || "-"}`);
    console.log(`socials: ${Object.entries(r.socialLinks).filter(([, v]) => v).map(([k]) => k).join(", ") || "-"}`);
    if (b) {
      console.log(`type: ${b.businessType ?? "-"} | address: ${b.address ?? "-"} | hours: ${b.openingHours.length} | services: ${b.services.slice(0, 5).join(", ") || "-"}`);
      console.log(`description: ${(b.description ?? b.summary ?? "-").slice(0, 110)}`);
      console.log(`booking: ${b.bookingUrl ?? "-"} | platform: ${b.platform ?? "-"}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
