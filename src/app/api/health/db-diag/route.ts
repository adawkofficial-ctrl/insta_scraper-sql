import { NextResponse } from "next/server";
import * as mariadb from "mariadb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMPORARY deploy diagnostic: reports the raw MySQL connection error (never the password).
export async function GET(): Promise<Response> {
  const raw = process.env.DATABASE_URL ?? "";
  const out: Record<string, unknown> = {};
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return NextResponse.json({ error: "DATABASE_URL not parseable" });
  }
  out.user = decodeURIComponent(u.username);
  out.db = u.pathname.slice(1);
  out.port = u.port || "3306";
  out.passwordLength = decodeURIComponent(u.password).length;
  for (const host of [u.hostname, "localhost", "127.0.0.1"]) {
    try {
      const c = await mariadb.createConnection({
        host,
        port: Number(u.port || 3306),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: u.pathname.slice(1),
        connectTimeout: 5000,
      });
      const t = await c.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()");
      out[host] = { ok: true, tables: String(t[0]?.n) };
      await c.end();
    } catch (e) {
      const err = e as { code?: string; errno?: number; message?: string };
      out[host] = { ok: false, code: err.code, errno: err.errno, message: String(err.message ?? e).slice(0, 300) };
    }
  }
  return NextResponse.json(out);
}
