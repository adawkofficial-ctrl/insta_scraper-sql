/**
 * Lightweight secret scanner. Reports only file:line and rule name; never the
 * matched value. Run: npm run scan:secrets
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".next-test",
  "artifacts",
  "data",
  "coverage",
  "dist",
  "browser_profiles",
]);
const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
  ".json",
  ".md",
  ".txt",
  ".sql",
  ".yml",
  ".yaml",
  ".env",
  ".example",
  ".toml",
]);

const RULES: Array<{ name: string; regex: RegExp }> = [
  {
    name: "connection-string-with-password",
    regex: /\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]+:[^\s@/]+@/i,
  },
  { name: "openai-key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { name: "slack-token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "github-token", regex: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: "password-literal",
    regex: /\b(?:password|passwd|pwd)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  },
  {
    name: "api-key-literal",
    regex: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/i,
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...walk(full));
    } else if (stat.isFile()) {
      const ext = extname(entry).toLowerCase();
      if (TEXT_EXT.has(ext) || entry === ".env.example" || entry === ".gitignore") {
        out.push(full);
      }
    }
  }
  return out;
}

// Obvious test fixtures / sanitizer inputs (not credentials).
const FIXTURE_ALLOW = [
  /Password123!?/i,
  /WrongPassword/i,
  /AnotherPassword/i,
  /SomePassword/i,
  /ValidPassword/i,
  /StrongProductionPassword/i,
  /ProductionReady2026!/i,
  /SecureMemberPass/i,
  /AdminPass2026!Secure/i,
  /devpassword/i,
  /sanitizeMessage\(/,
  /rapidapi-secret-key-/,
  /sk-abcdefghijklmnopqrstuvwx/,
  /postgresql:\/\/user:pass@host/,
  /mysql:\/\/user:pass@/,
  /mysql:\/\/user:password@/,
  /postgresql:\/\/user:password@/,
  /mysql:\/\/root:root@127\.0\.0\.1/,
  /user:pass@localhost/,
  /USER:PASSWORD@HOST/,
  /test-rapidapi-key-/,
  /NODE_ENV=production/,
];

const findings: Array<{ file: string; line: number; rule: string }> = [];
for (const file of walk(ROOT)) {
  if (file.endsWith(".env") || file.includes(`${join(ROOT, ".env.")}`)) {
    // .env.example is allowed; real .env files are excluded from this scan.
    if (!file.endsWith(".env.example")) continue;
  }
  const content = readFileSync(file, "utf8");
  content.split(/\r?\n/).forEach((text, index) => {
    if (FIXTURE_ALLOW.some((pattern) => pattern.test(text))) return;
    for (const rule of RULES) {
      if (rule.regex.test(text)) {
        findings.push({ file: relative(ROOT, file), line: index + 1, rule: rule.name });
        break;
      }
    }
  });
}

if (findings.length === 0) {
  console.log(`scan:secrets PASS (${walk(ROOT).length} files scanned)`);
  process.exit(0);
}

for (const finding of findings) {
  console.log(`SECRET ${finding.file}:${finding.line} [${finding.rule}]`);
}
console.log(`scan:secrets FAIL (${findings.length} finding(s)); values were not printed.`);
process.exit(1);
