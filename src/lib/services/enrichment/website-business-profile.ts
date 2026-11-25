/**
 * Business-profile extraction from a lead's website.
 *
 * Pure functions (no I/O) so they can be unit-tested against fixture HTML.
 * Pulls what a salesperson actually wants to know before reaching out:
 * what the business is, what it sells, where it is, when it's open, and
 * how it presents itself — from <meta> tags, schema.org JSON-LD and the
 * page's own headings/copy.
 */

export type WebsiteBusinessProfile = {
  /** <title>, entity-decoded. */
  title: string | null;
  /** meta description / og:description / JSON-LD description. */
  description: string | null;
  siteName: string | null;
  h1: string | null;
  /** schema.org @type, e.g. "Dentist", "Restaurant", "LocalBusiness". */
  businessType: string | null;
  /** schema.org name. */
  businessName: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  openingHours: string[];
  priceRange: string | null;
  rating: number | null;
  reviewCount: number | null;
  /** Offerings: schema.org services/offers/menu + service-like headings. */
  services: string[];
  /** meta keywords. */
  keywords: string[];
  areaServed: string[];
  logo: string | null;
  image: string | null;
  language: string | null;
  foundedYear: number | null;
  /** First substantive paragraph of copy (≤ 320 chars). */
  summary: string | null;
  /** Booking / appointment / order link if one is linked. */
  bookingUrl: string | null;
  /** Detected site builder / platform (Wix, Shopify, WordPress, ...). */
  platform: string | null;
  /** URLs the profile was assembled from. */
  sourceUrls: string[];
};

const MAX_SERVICES = 15;
const MAX_KEYWORDS = 15;
const MAX_HOURS = 14;

export function emptyBusinessProfile(): WebsiteBusinessProfile {
  return {
    title: null,
    description: null,
    siteName: null,
    h1: null,
    businessType: null,
    businessName: null,
    address: null,
    city: null,
    region: null,
    postalCode: null,
    country: null,
    latitude: null,
    longitude: null,
    openingHours: [],
    priceRange: null,
    rating: null,
    reviewCount: null,
    services: [],
    keywords: [],
    areaServed: [],
    logo: null,
    image: null,
    language: null,
    foundedYear: null,
    summary: null,
    bookingUrl: null,
    platform: null,
    sourceUrls: [],
  };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  middot: "·",
  bull: "•",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return match;
      try {
        return String.fromCodePoint(n);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function clean(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const text = decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ");
}

function uniquePush(list: string[], value: string | null, max: number) {
  if (!value || list.length >= max) return;
  const key = value.toLowerCase();
  if (list.some((existing) => existing.toLowerCase() === key)) return;
  list.push(value);
}

// ---------------------------------------------------------------------------
// <meta> parsing
// ---------------------------------------------------------------------------

export function readMetaTags(html: string): Map<string, string> {
  const metas = new Map<string, string>();
  const metaRegex = /<meta\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRegex.exec(html)) !== null) {
    const tag = match[0];
    const key = /\b(?:property|name|itemprop)\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(tag);
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (!key || !content) continue;
    const name = (key[1] ?? key[2] ?? "").trim().toLowerCase();
    const value = (content[1] ?? content[2] ?? "").trim();
    if (name && value && !metas.has(name)) metas.set(name, value);
  }
  return metas;
}

// ---------------------------------------------------------------------------
// JSON-LD parsing
// ---------------------------------------------------------------------------

/** Parse every JSON-LD block, tolerating comments, CDATA and trailing junk. */
export function parseJsonLdBlocks(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const regex = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const body = match[1]
      .replace(/^\s*<!\[CDATA\[/, "")
      .replace(/\]\]>\s*$/, "")
      .replace(/^\s*<!--/, "")
      .replace(/-->\s*$/, "")
      .trim();
    if (!body) continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Some CMSs emit raw newlines/tabs inside strings, or a trailing ";".
      try {
        parsed = JSON.parse(body.replace(/[\r\n\t]+/g, " ").replace(/;\s*$/, ""));
      } catch {
        parsed = null;
      }
    }
    const collect = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      const record = value as Record<string, unknown>;
      nodes.push(record);
      if (Array.isArray(record["@graph"])) (record["@graph"] as unknown[]).forEach(collect);
    };
    collect(parsed);
  }
  return nodes;
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

const NON_BUSINESS_TYPES = new Set([
  "website",
  "webpage",
  "breadcrumblist",
  "listitem",
  "searchaction",
  "imageobject",
  "person",
  "readaction",
  "sitenavigationelement",
  "wpheader",
  "wpfooter",
  "article",
  "blogposting",
  "faqpage",
  "question",
  "answer",
  "videoobject",
  "collectionpage",
  "aboutpage",
  "contactpage",
  "entrypoint",
  "propertyvalue",
]);

function isBusinessNode(node: Record<string, unknown>): boolean {
  const types = typesOf(node).map((t) => t.toLowerCase());
  if (types.length === 0) return false;
  if (types.every((t) => NON_BUSINESS_TYPES.has(t))) return false;
  return Boolean(node.name || node.address || node.telephone || node.openingHours || node.openingHoursSpecification);
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string") return record.name;
    if (typeof record.url === "string") return record.url;
    if (typeof record["@id"] === "string") return record["@id"];
  }
  return null;
}

function asNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseFloat(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

const DAY_ABBR: Record<string, string> = {
  monday: "Mo",
  tuesday: "Tu",
  wednesday: "We",
  thursday: "Th",
  friday: "Fr",
  saturday: "Sa",
  sunday: "Su",
};

function dayLabel(raw: unknown): string {
  const text = asString(raw) ?? "";
  const last = text.split("/").pop() ?? text;
  return DAY_ABBR[last.toLowerCase()] ?? last;
}

function readOpeningHours(node: Record<string, unknown>, out: string[]) {
  const hours = node.openingHours;
  if (typeof hours === "string") {
    hours.split(/,(?=\s*[A-Z][a-z])/).forEach((h) => uniquePush(out, clean(h, 80), MAX_HOURS));
  } else if (Array.isArray(hours)) {
    hours.forEach((h) => uniquePush(out, clean(h, 80), MAX_HOURS));
  }
  const spec = node.openingHoursSpecification;
  const specs = Array.isArray(spec) ? spec : spec ? [spec] : [];
  for (const entry of specs) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const days = Array.isArray(record.dayOfWeek) ? record.dayOfWeek : [record.dayOfWeek];
    const label = days.filter(Boolean).map(dayLabel).join(",");
    const opens = asString(record.opens)?.slice(0, 5);
    const closes = asString(record.closes)?.slice(0, 5);
    if (!label) continue;
    uniquePush(out, opens && closes ? `${label} ${opens}-${closes}` : label, MAX_HOURS);
  }
}

function readServicesFromNode(node: Record<string, unknown>, out: string[]) {
  // Breadcrumbs / site navigation are page links, not offerings.
  if (typesOf(node).some((t) => /breadcrumb|sitenavigation|webpage|website/i.test(t))) return;
  const push = (value: unknown) => {
    const name = clean(asString(value), 80);
    if (name && name.length >= 3 && !HEADING_NOISE.test(name)) uniquePush(out, name, MAX_SERVICES);
  };
  for (const key of ["makesOffer", "hasOfferCatalog", "knowsAbout", "serviceType", "hasMenu", "itemListElement", "offers"]) {
    const value = node[key];
    const items = Array.isArray(value) ? value : value ? [value] : [];
    for (const item of items) {
      if (typeof item === "string") {
        push(item);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (record.itemOffered) push(record.itemOffered);
      else if (record.name) push(record.name);
      if (Array.isArray(record.itemListElement)) readServicesFromNode(record, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Copy / heading heuristics
// ---------------------------------------------------------------------------

const HEADING_NOISE =
  /^(home|menu|contact|contact us|about|about us|welcome|blog|news|faq|faqs|gallery|testimonials?|reviews?|follow us|get in touch|location|locations|hours|our team|team|careers|privacy|terms|cart|search|login|sign in|subscribe|newsletter|share|read more|learn more|book now|call now|quick links|useful links|social|connect)$/i;

function extractServiceHeadings(html: string, out: string[]) {
  // Drop site chrome first: navigation menus use class="menu"/"services"
  // dropdowns and would otherwise be read as a list of services.
  const body = stripNonContent(html).replace(/<(header|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  // Headings inside a content section that looks like a services list.
  const sectionRegex = /<(section|div|ul)\b(?![^>]*(?:nav|dropdown|sub-?menu|menu-item|main-menu|primary-menu|mobile-menu|breadcrumb))[^>]*(?:id|class)\s*=\s*["'][^"']*(service|treatment|food-menu|menu-section|offer|product|program)[^"']*["'][^>]*>([\s\S]{0,6000}?)<\/\1>/gi;
  let sectionMatch: RegExpExecArray | null;
  while ((sectionMatch = sectionRegex.exec(body)) !== null && out.length < MAX_SERVICES) {
    const inner = sectionMatch[3];
    const itemRegex = /<(h[2-4]|li|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let item: RegExpExecArray | null;
    while ((item = itemRegex.exec(inner)) !== null && out.length < MAX_SERVICES) {
      const text = clean(item[2], 70);
      if (!text || text.length < 3 || text.split(" ").length > 7) continue;
      // Text that glues several nav labels together ("Services General Dentistry Botox").
      if (/^(services?|home|about)\b/i.test(text) && text.split(" ").length > 2) continue;
      if (HEADING_NOISE.test(text) || /[|©@]|https?:/i.test(text)) continue;
      uniquePush(out, text, MAX_SERVICES);
    }
  }
}

function extractSummary(html: string): string | null {
  const body = stripNonContent(html)
    .replace(/<(header|nav|footer)\b[\s\S]*?<\/\1>/gi, " ");
  const paragraphRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null;
  while ((match = paragraphRegex.exec(body)) !== null) {
    const text = clean(match[1], 2000);
    if (!text || text.length < 60) continue;
    if (/cookie|javascript|browser|copyright|all rights reserved|privacy policy/i.test(text)) continue;
    return text.length > 320 ? `${text.slice(0, 319).trimEnd()}…` : text;
  }
  return null;
}

const BOOKING_HOSTS =
  /calendly\.com|acuityscheduling\.com|squareup\.com\/appointments|square\.site|\/\/book\.|\/\/booking\.|\/booking|recallmax\.com|opentable\.|resy\.com|vagaro\.com|mindbodyonline\.com|fresha\.com|janeapp\.com|setmore\.com|simplybook\.|zocdoc\.com|ubereats\.com|doordash\.com|skipthedishes\.com|toasttab\.com/i;

function extractBookingUrl(html: string, pageUrl: string): string | null {
  const anchorRegex = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  let fallback: string | null = null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1].trim();
    const text = clean(match[2], 80) ?? "";
    let absolute: string;
    try {
      absolute = new URL(decodeEntities(href), pageUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(absolute)) continue;
    if (BOOKING_HOSTS.test(absolute)) return absolute;
    // A "Book" link to a social profile is not a booking system.
    if (/facebook\.com|instagram\.com|twitter\.com|\/\/x\.com|tiktok\.com|youtube\.com|linkedin\.com/i.test(absolute)) continue;
    if (!fallback && /\b(book|appointment|reserve|reservation|schedule|order online|order now)\b/i.test(text)) {
      fallback = absolute;
    }
  }
  return fallback;
}

function detectPlatform(html: string, metas: Map<string, string>): string | null {
  const generator = metas.get("generator") ?? "";
  if (/wordpress/i.test(generator) || /wp-content\//i.test(html)) return "WordPress";
  if (/wix\.com|wixstatic\.com|_wixCIDX/i.test(html) || /wix/i.test(generator)) return "Wix";
  if (/cdn\.shopify\.com|Shopify\.theme/i.test(html)) return "Shopify";
  if (/squarespace/i.test(generator) || /static1\.squarespace\.com/i.test(html)) return "Squarespace";
  if (/webflow/i.test(generator) || /assets\.website-files\.com/i.test(html)) return "Webflow";
  if (/godaddy|img1\.wsimg\.com/i.test(generator + html.slice(0, 20000))) return "GoDaddy";
  if (/joomla/i.test(generator)) return "Joomla";
  if (/drupal/i.test(generator)) return "Drupal";
  if (/__NEXT_DATA__|\/_next\/static/i.test(html)) return "Next.js";
  return generator ? clean(generator, 40) : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extractBusinessProfile(html: string, pageUrl: string): WebsiteBusinessProfile {
  const profile = emptyBusinessProfile();
  profile.sourceUrls = [pageUrl];
  const metas = readMetaTags(html);

  profile.title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1], 200);
  profile.h1 = clean(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(stripNonContent(html))?.[1], 200);
  profile.siteName = clean(metas.get("og:site_name"), 120) ?? clean(metas.get("application-name"), 120);
  profile.description =
    clean(metas.get("description"), 400) ??
    clean(metas.get("og:description"), 400) ??
    clean(metas.get("twitter:description"), 400);
  profile.image = clean(metas.get("og:image"), 500);
  profile.language = clean(/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html)?.[1], 12);

  const keywordMeta = metas.get("keywords");
  if (keywordMeta) {
    keywordMeta
      .split(/[,;|]/)
      .map((k) => clean(k, 50))
      .forEach((k) => {
        if (k && k.length >= 3) uniquePush(profile.keywords, k, MAX_KEYWORDS);
      });
  }

  // schema.org JSON-LD: prefer the most "business-like" node.
  const nodes = parseJsonLdBlocks(html);
  const businessNodes = nodes.filter(isBusinessNode);
  const primary =
    businessNodes.find((n) => typesOf(n).some((t) => !/^organization$/i.test(t))) ?? businessNodes[0] ?? null;

  if (primary) {
    const types = typesOf(primary);
    profile.businessType = types.find((t) => !/^(organization|thing)$/i.test(t)) ?? types[0] ?? null;
    profile.businessName = clean(asString(primary.name), 160);
    profile.description = profile.description ?? clean(asString(primary.description), 400);
    profile.priceRange = clean(asString(primary.priceRange), 20);
    profile.logo = clean(asString(primary.logo), 500);
    profile.image = profile.image ?? clean(asString(Array.isArray(primary.image) ? primary.image[0] : primary.image), 500);

    const founded = asString(primary.foundingDate);
    const year = founded ? parseInt(founded.slice(0, 4), 10) : NaN;
    if (Number.isFinite(year) && year > 1800 && year <= new Date().getFullYear()) profile.foundedYear = year;

    const address = Array.isArray(primary.address) ? primary.address[0] : primary.address;
    if (typeof address === "string") {
      profile.address = clean(address, 200);
    } else if (address && typeof address === "object") {
      const a = address as Record<string, unknown>;
      const street = clean(asString(a.streetAddress), 120);
      profile.city = clean(asString(a.addressLocality), 80);
      profile.region = clean(asString(a.addressRegion), 80);
      profile.postalCode = clean(asString(a.postalCode), 20);
      profile.country = clean(asString(a.addressCountry), 60);
      // Some sites put the full address in streetAddress; don't repeat parts.
      const streetLower = (street ?? "").toLowerCase();
      const rest = [profile.city, profile.region, profile.postalCode].filter(
        (part): part is string => Boolean(part) && !streetLower.includes(part!.toLowerCase()),
      );
      profile.address = [street, ...rest].filter(Boolean).join(", ") || null;
    }

    const geo = primary.geo as Record<string, unknown> | undefined;
    if (geo && typeof geo === "object") {
      profile.latitude = asNumber(geo.latitude);
      profile.longitude = asNumber(geo.longitude);
    }

    const rating = primary.aggregateRating as Record<string, unknown> | undefined;
    if (rating && typeof rating === "object") {
      profile.rating = asNumber(rating.ratingValue);
      profile.reviewCount = asNumber(rating.reviewCount ?? rating.ratingCount);
    }

    const area = primary.areaServed;
    const areas = Array.isArray(area) ? area : area ? [area] : [];
    areas.forEach((a) => uniquePush(profile.areaServed, clean(asString(a), 60), 10));
  }
  for (const node of businessNodes) readOpeningHours(node, profile.openingHours);
  for (const node of nodes) readServicesFromNode(node, profile.services);
  for (const node of nodes) {
    if (typesOf(node).some((t) => /^service$/i.test(t))) {
      uniquePush(profile.services, clean(asString(node.name), 80), MAX_SERVICES);
    }
  }

  // Microdata fallback for hours: <meta itemprop="openingHours" content="Mo-Fr 09:00-17:00">
  if (profile.openingHours.length === 0) {
    const hoursRegex = /itemprop\s*=\s*["']openingHours["'][^>]*content\s*=\s*["']([^"']+)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = hoursRegex.exec(html)) !== null) uniquePush(profile.openingHours, clean(match[1], 80), MAX_HOURS);
  }

  extractServiceHeadings(html, profile.services);
  profile.summary = extractSummary(html);
  profile.bookingUrl = extractBookingUrl(html, pageUrl);
  profile.platform = detectPlatform(html, metas);

  return profile;
}

/**
 * Merge a subpage profile into the homepage profile. The homepage wins for
 * identity fields; subpages fill gaps (contact pages usually carry the
 * address and hours, service pages the offerings).
 */
export function mergeBusinessProfiles(
  base: WebsiteBusinessProfile,
  extra: WebsiteBusinessProfile,
): WebsiteBusinessProfile {
  const merged: WebsiteBusinessProfile = { ...base };
  const scalarKeys = [
    "title",
    "description",
    "siteName",
    "h1",
    "businessType",
    "businessName",
    "address",
    "city",
    "region",
    "postalCode",
    "country",
    "latitude",
    "longitude",
    "priceRange",
    "rating",
    "reviewCount",
    "logo",
    "image",
    "language",
    "foundedYear",
    "summary",
    "bookingUrl",
    "platform",
  ] as const;
  for (const key of scalarKeys) {
    if (merged[key] === null && extra[key] !== null) {
      (merged as Record<string, unknown>)[key] = extra[key];
    }
  }
  const mergeList = (a: string[], b: string[], max: number) => {
    const out = [...a];
    b.forEach((v) => uniquePush(out, v, max));
    return out;
  };
  merged.openingHours = mergeList(base.openingHours, extra.openingHours, MAX_HOURS);
  merged.services = mergeList(base.services, extra.services, MAX_SERVICES);
  merged.keywords = mergeList(base.keywords, extra.keywords, MAX_KEYWORDS);
  merged.areaServed = mergeList(base.areaServed, extra.areaServed, 10);
  merged.sourceUrls = mergeList(base.sourceUrls, extra.sourceUrls, 10);
  return merged;
}

/** True if the profile carries anything worth showing. */
export function hasBusinessData(profile: WebsiteBusinessProfile | null | undefined): boolean {
  if (!profile) return false;
  return Boolean(
    profile.description ||
      profile.businessType ||
      profile.address ||
      profile.openingHours.length ||
      profile.services.length ||
      profile.summary ||
      profile.priceRange ||
      profile.bookingUrl,
  );
}
