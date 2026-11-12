/**
 * Robust RFC 4180 compliant CSV parser and column mapper for Instagram lead imports.
 */

export type ParsedCsvLead = {
  username: string;
  profileUrl: string;
  fullName: string | null;
  biography: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  category: string | null;
  followersCount: number | null;
  followingCount: number | null;
  postsCount: number | null;
  isVerified: boolean | null;
  isBusinessAccount: boolean | null;
  location: string | null;
  rawRowIndex: number;
};

export type CsvParseResult = {
  success: boolean;
  totalRows: number;
  validCount: number;
  invalidCount: number;
  headers: string[];
  columnMapping: Record<string, string>;
  leads: ParsedCsvLead[];
  errors: Array<{ row: number; reason: string; snippet: string }>;
  previewRows: Array<Record<string, string>>;
};

const USERNAME_REGEX = /^(?!\.)(?!.*\.\.)[a-zA-Z0-9._]{1,30}(?<!\.)$/;

const NON_PROFILE_PATHS = new Set([
  "p",
  "reel",
  "reels",
  "explore",
  "stories",
  "tv",
  "share",
  "channel",
  "direct",
  "accounts",
  "about",
  "legal",
  "developer",
]);

/**
 * Normalizes an Instagram username or profile URL into a clean handle.
 */
export function normalizeCsvHandle(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;

  let text = raw.trim();
  if (!text) return null;

  // Handle URL form
  if (
    text.includes("instagram.com") ||
    text.includes("instagr.am") ||
    text.startsWith("http://") ||
    text.startsWith("https://")
  ) {
    try {
      const urlStr = text.startsWith("http") ? text : `https://${text}`;
      const parsed = new URL(urlStr);
      const segments = parsed.pathname
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);

      if (segments.length === 0) return null;
      const firstSegment = segments[0].toLowerCase();
      if (NON_PROFILE_PATHS.has(firstSegment)) return null;

      text = segments[0];
    } catch {
      // Fallback regex extraction if URL parsing fails
      const match = text.match(/instagram\.com\/([a-zA-Z0-9._]+)/i);
      if (match && match[1]) {
        text = match[1];
      }
    }
  }

  // Strip leading @, trailing punctuation, whitespace
  text = text.replace(/^@+/, "").trim();

  // Remove query params or slashes if still present
  if (text.includes("?")) text = text.split("?")[0];
  if (text.includes("/")) text = text.split("/")[0];

  const normalized = text.toLowerCase();
  if (NON_PROFILE_PATHS.has(normalized)) return null;
  if (!USERNAME_REGEX.test(normalized)) return null;

  return normalized;
}

/**
 * Normalizes email address.
 */
function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(trimmed) ? trimmed : null;
}

/**
 * Normalizes phone number to clean string.
 */
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digitsOnly = trimmed.replace(/\D/g, "");
  if (digitsOnly.length < 7 || digitsOnly.length > 15) return null;
  return trimmed;
}

/**
 * Parses a numeric integer value safely.
 */
function parseInteger(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[,\s]/g, "");
  const num = Number.parseInt(cleaned, 10);
  return Number.isNaN(num) ? null : Math.max(0, num);
}

/**
 * Parses a boolean value.
 */
function parseBoolean(raw: string | null | undefined): boolean | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "1" || lower === "verified") return true;
  if (lower === "false" || lower === "no" || lower === "0" || lower === "unverified") return false;
  return null;
}

/**
 * Splits raw CSV text into a 2D array of rows and cells according to RFC 4180.
 * Automatically handles quotes, multi-line values, and detects delimiter (, ; \t).
 */
export function parseCsvRows(csvText: string): string[][] {
  const text = csvText.trim();
  if (!text) return [];

  // Auto-detect delimiter from first non-empty line
  const firstLine = text.split(/\r\n|\n/)[0] || "";
  let delimiter = ",";
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const tabCount = (firstLine.match(/\t/g) || []).length;
  if (semiCount > commaCount && semiCount > tabCount) delimiter = ";";
  if (tabCount > commaCount && tabCount > semiCount) delimiter = "\t";

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // Escaped quote: ""
          currentField += '"';
          i += 2;
          continue;
        } else {
          // Closing quote
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      } else if (char === delimiter) {
        currentRow.push(currentField.trim());
        currentField = "";
        i++;
        continue;
      } else if (char === "\r") {
        if (nextChar === "\n") i++; // handle \r\n
        currentRow.push(currentField.trim());
        if (currentRow.some((c) => c.length > 0)) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = "";
        i++;
        continue;
      } else if (char === "\n") {
        currentRow.push(currentField.trim());
        if (currentRow.some((c) => c.length > 0)) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = "";
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  // Push final field/row if any
  currentRow.push(currentField.trim());
  if (currentRow.some((c) => c.length > 0)) {
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Standard column aliases map.
 */
const FIELD_ALIASES: Record<string, string[]> = {
  username: [
    "username",
    "handle",
    "instagram",
    "instagram_handle",
    "instagram_username",
    "ig",
    "ig_handle",
    "ig_username",
    "profile",
    "profile_url",
    "profileurl",
    "instagram_url",
    "account",
    "user",
  ],
  fullName: [
    "fullname",
    "full_name",
    "name",
    "first_name",
    "display_name",
    "contact_name",
    "owner",
  ],
  biography: [
    "biography",
    "bio",
    "description",
    "about",
    "summary",
    "profile_bio",
  ],
  email: [
    "email",
    "email_address",
    "mail",
    "contact_email",
    "business_email",
  ],
  phone: [
    "phone",
    "phone_number",
    "telephone",
    "mobile",
    "contact_phone",
    "whatsapp",
  ],
  website: [
    "website",
    "url",
    "link",
    "external_url",
    "website_url",
    "site",
    "domain",
  ],
  category: [
    "category",
    "niche",
    "industry",
    "business_category",
    "category_name",
    "tags",
  ],
  followersCount: [
    "followers",
    "followers_count",
    "follower_count",
    "follower",
  ],
  followingCount: [
    "following",
    "following_count",
    "follows_count",
    "follows",
  ],
  postsCount: [
    "posts",
    "posts_count",
    "media_count",
  ],
  isVerified: [
    "verified",
    "is_verified",
    "isverified",
  ],
  isBusinessAccount: [
    "is_business",
    "is_business_account",
    "business",
    "isbusiness",
  ],
  location: [
    "location",
    "city",
    "country",
    "address",
    "state",
  ],
};

/**
 * Maps CSV header row to standard lead fields.
 */
export function detectColumnMapping(headers: string[]): Record<string, number> {
  const mapping: Record<string, number> = {};
  const normalizedHeaders = headers.map((h) =>
    h.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, ""),
  );

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    // 1. Exact match first
    let foundIndex = normalizedHeaders.findIndex((h) => aliases.includes(h));

    // 2. Word-boundary or token match
    if (foundIndex === -1) {
      foundIndex = normalizedHeaders.findIndex((h) => {
        const words = h.split("_");
        return aliases.some((alias) => words.includes(alias) || (alias.length >= 4 && h.includes(alias)));
      });
    }

    if (foundIndex !== -1) {
      mapping[field] = foundIndex;
    }
  }

  return mapping;
}

/**
 * Parses and maps CSV data into structured Lead objects.
 */
export function parseLeadCsv(csvText: string, maxRows: number = 2000): CsvParseResult {
  const rawRows = parseCsvRows(csvText);
  if (rawRows.length === 0) {
    return {
      success: true,
      totalRows: 0,
      validCount: 0,
      invalidCount: 0,
      headers: [],
      columnMapping: {},
      leads: [],
      errors: [],
      previewRows: [],
    };
  }

  // Check if row 0 is a header
  const firstRow = rawRows[0];
  const detectedMapping = detectColumnMapping(firstRow);
  const hasHeaderRow = Boolean(detectedMapping.username !== undefined || Object.keys(detectedMapping).length >= 2);

  let headers: string[] = [];
  let dataRows: string[][] = [];
  let mapping: Record<string, number> = {};

  if (hasHeaderRow) {
    headers = firstRow;
    mapping = detectedMapping;
    dataRows = rawRows.slice(1, maxRows + 1);
  } else {
    // Headerless CSV: detect which column contains instagram handles or URLs
    dataRows = rawRows.slice(0, maxRows);
    let bestUsernameCol = 0;
    let maxHandleMatches = 0;

    const sampleRows = dataRows.slice(0, 10);
    const colCount = Math.max(...sampleRows.map((r) => r.length), 1);

    for (let c = 0; c < colCount; c++) {
      let matches = 0;
      for (const row of sampleRows) {
        if (c < row.length && normalizeCsvHandle(row[c])) {
          matches++;
        }
      }
      if (matches > maxHandleMatches) {
        maxHandleMatches = matches;
        bestUsernameCol = c;
      }
    }

    mapping = { username: bestUsernameCol };
    headers = Array.from({ length: colCount }, (_, i) =>
      i === bestUsernameCol ? "username" : `column_${i + 1}`,
    );
  }

  // Fallback: if username column is still not mapped, try column 0
  if (mapping.username === undefined) {
    mapping.username = 0;
  }

  const leads: ParsedCsvLead[] = [];
  const errors: Array<{ row: number; reason: string; snippet: string }> = [];
  const seenUsernames = new Set<string>();
  const previewRows: Array<Record<string, string>> = [];

  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r];
    const rowNum = hasHeaderRow ? r + 2 : r + 1;

    const rawUsername = row[mapping.username] || "";
    const cleanUsername = normalizeCsvHandle(rawUsername);

    if (!cleanUsername) {
      errors.push({
        row: rowNum,
        reason: rawUsername.trim()
          ? `Invalid Instagram handle: "${rawUsername.slice(0, 30)}"`
          : "Empty username column",
        snippet: row.join(", ").slice(0, 60),
      });
      continue;
    }

    if (seenUsernames.has(cleanUsername)) {
      // Duplicate handle within this file; skip subsequent occurrences
      continue;
    }
    seenUsernames.add(cleanUsername);

    const getCol = (field: string): string | null => {
      const idx = mapping[field];
      if (idx !== undefined && idx < row.length && row[idx].trim().length > 0) {
        return row[idx].trim();
      }
      return null;
    };

    const lead: ParsedCsvLead = {
      username: cleanUsername,
      profileUrl: `https://www.instagram.com/${cleanUsername}/`,
      fullName: getCol("fullName"),
      biography: getCol("biography"),
      email: normalizeEmail(getCol("email")),
      phone: normalizePhone(getCol("phone")),
      website: getCol("website"),
      category: getCol("category"),
      followersCount: parseInteger(getCol("followersCount")),
      followingCount: parseInteger(getCol("followingCount")),
      postsCount: parseInteger(getCol("postsCount")),
      isVerified: parseBoolean(getCol("isVerified")),
      isBusinessAccount: parseBoolean(getCol("isBusinessAccount")),
      location: getCol("location"),
      rawRowIndex: rowNum,
    };

    leads.push(lead);

    if (previewRows.length < 5) {
      const previewObj: Record<string, string> = {
        username: `@${cleanUsername}`,
      };
      if (lead.fullName) previewObj.fullName = lead.fullName;
      if (lead.email) previewObj.email = lead.email;
      if (lead.phone) previewObj.phone = lead.phone;
      if (lead.category) previewObj.category = lead.category;
      if (lead.followersCount != null) previewObj.followers = String(lead.followersCount);
      previewRows.push(previewObj);
    }
  }

  const humanMapping: Record<string, string> = {};
  for (const [field, colIdx] of Object.entries(mapping)) {
    humanMapping[field] = headers[colIdx] || `Col ${colIdx + 1}`;
  }

  return {
    success: true,
    totalRows: dataRows.length,
    validCount: leads.length,
    invalidCount: errors.length,
    headers,
    columnMapping: humanMapping,
    leads,
    errors: errors.slice(0, 20), // Return up to first 20 errors for user feedback
    previewRows,
  };
}
