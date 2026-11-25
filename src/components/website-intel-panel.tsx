"use client";

import { useState } from "react";

/**
 * Shows everything the website scraper pulled off a lead's site:
 * business profile (what they do, services, hours, address), every
 * email/phone with the page it came from, and per-page scan diagnostics.
 *
 * Reads `rawProfileData.websiteEnrichment` + `rawProfileData.contacts`, which
 * are written by website-lead-enricher.ts / website-contact-extractor.ts.
 */

type BusinessProfile = {
  title?: string | null;
  description?: string | null;
  siteName?: string | null;
  businessType?: string | null;
  businessName?: string | null;
  address?: string | null;
  openingHours?: string[];
  priceRange?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  services?: string[];
  keywords?: string[];
  areaServed?: string[];
  logo?: string | null;
  foundedYear?: number | null;
  summary?: string | null;
  bookingUrl?: string | null;
  platform?: string | null;
  language?: string | null;
};

type PageDiagnostic = {
  url: string;
  ok: boolean;
  status: number | null;
  emails?: string[];
  phones?: string[];
  error?: string;
};

type ContactEntry = {
  value?: string;
  normalized?: string;
  source?: string;
  sourceUrl?: string;
  generic?: boolean;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pathOf(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" ? "home" : parsed.pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function humanizeType(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "brand" | "neutral" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        tone === "brand"
          ? "border-orange-500/30 bg-orange-500/10 text-orange-300"
          : "border-white/10 bg-white/[0.04] text-zinc-300"
      }`}
    >
      {children}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-3 border-b border-zinc-800/60 py-2 last:border-b-0">
      <span className="text-zinc-500">{label}</span>
      <div className="min-w-0 text-zinc-200">{children}</div>
    </div>
  );
}

export function WebsiteIntelPanel({
  rawProfileData,
  onRescan,
  rescanning = false,
}: {
  rawProfileData: unknown;
  onRescan?: () => void;
  rescanning?: boolean;
}) {
  const [showPages, setShowPages] = useState(false);
  const raw = asObject(rawProfileData);
  const enrichment = asObject(raw?.websiteEnrichment);
  const business = (asObject(enrichment?.business) ?? null) as BusinessProfile | null;
  const pages = (Array.isArray(enrichment?.pages) ? enrichment?.pages : []) as PageDiagnostic[];
  const contacts = asObject(raw?.contacts);
  const emails = (Array.isArray(contacts?.emails) ? contacts?.emails : []) as ContactEntry[];
  const phones = (Array.isArray(contacts?.phones) ? contacts?.phones : []) as ContactEntry[];
  const fetchedAt = typeof enrichment?.fetchedAt === "string" ? enrichment.fetchedAt : null;

  if (!enrichment) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 p-4 text-center">
        <p className="text-xs text-zinc-400">This lead&apos;s website hasn&apos;t been scanned yet.</p>
        {onRescan && (
          <button
            type="button"
            onClick={onRescan}
            disabled={rescanning}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-semibold text-white shadow-[0_6px_18px_-8px_rgba(255,122,26,0.8)] transition hover:brightness-110 disabled:opacity-50"
          >
            {rescanning ? "Scanning…" : "Scan website"}
          </button>
        )}
      </div>
    );
  }

  const okPages = pages.filter((p) => p.ok).length;
  const services = business?.services ?? [];
  const hours = business?.openingHours ?? [];
  const keywords = business?.keywords ?? [];
  const description = business?.description || business?.summary || null;

  return (
    <div className="accent-top overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/60 animate-fade-up">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-orange-500/15 text-orange-400">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 21a9 9 0 100-18 9 9 0 000 18zm0 0c2.5-2.5 3.75-5.5 3.75-9S14.5 5.5 12 3m0 18c-2.5-2.5-3.75-5.5-3.75-9S9.5 5.5 12 3M3.5 9h17M3.5 15h17"
              />
            </svg>
          </span>
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-white">Website Intel</h4>
            <p className="text-[10px] text-zinc-500">
              {okPages}/{pages.length} pages scanned
              {fetchedAt ? ` · ${new Date(fetchedAt).toLocaleDateString()}` : ""}
            </p>
          </div>
        </div>
        {onRescan && (
          <button
            type="button"
            onClick={onRescan}
            disabled={rescanning}
            className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-orange-500/50 hover:text-orange-300 disabled:opacity-50"
          >
            {rescanning ? "Scanning…" : "Re-scan"}
          </button>
        )}
      </div>

      <div className="space-y-3 px-4 py-3 text-xs">
        {(business?.businessType || business?.priceRange || business?.platform || business?.foundedYear) && (
          <div className="flex flex-wrap gap-1.5">
            {business?.businessType && <Chip tone="brand">{humanizeType(business.businessType)}</Chip>}
            {business?.priceRange && <Chip>{business.priceRange}</Chip>}
            {business?.foundedYear && <Chip>Since {business.foundedYear}</Chip>}
            {business?.platform && <Chip>Built on {business.platform}</Chip>}
          </div>
        )}

        {description && <p className="leading-relaxed text-zinc-300">{description}</p>}

        <div>
          {business?.title && <Row label="Page title">{business.title}</Row>}
          {business?.address && <Row label="Address">{business.address}</Row>}
          {business?.rating != null && (
            <Row label="Site rating">
              <span className="text-yellow-300">★ {business.rating}</span>
              {business.reviewCount ? <span className="text-zinc-500"> ({business.reviewCount} reviews)</span> : null}
            </Row>
          )}
          {business?.bookingUrl && (
            <Row label="Booking">
              <a
                href={business.bookingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate text-orange-400 hover:text-orange-300 hover:underline"
              >
                {business.bookingUrl}
              </a>
            </Row>
          )}
          {(business?.areaServed?.length ?? 0) > 0 && <Row label="Serves">{business!.areaServed!.join(", ")}</Row>}
          {hours.length > 0 && (
            <Row label="Hours">
              <ul className="space-y-0.5 font-mono text-[11px] text-zinc-300">
                {hours.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </Row>
          )}
        </div>

        {services.length > 0 && (
          <div>
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Services & offerings
            </span>
            <div className="flex flex-wrap gap-1.5">
              {services.map((s) => (
                <Chip key={s}>{s}</Chip>
              ))}
            </div>
          </div>
        )}

        {keywords.length > 0 && (
          <div>
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Keywords</span>
            <p className="text-zinc-400">{keywords.join(" · ")}</p>
          </div>
        )}

        {(emails.length > 0 || phones.length > 0) && (
          <div>
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Contacts found ({emails.length + phones.length})
            </span>
            <ul className="space-y-1">
              {emails.map((e) => (
                <li key={`e-${e.value}`} className="flex items-center justify-between gap-2">
                  <a href={`mailto:${e.value}`} className="truncate text-zinc-200 hover:text-orange-300">
                    ✉ {e.value}
                  </a>
                  <span className="shrink-0 text-[10px] text-zinc-500">
                    {e.generic ? "generic · " : ""}
                    {e.sourceUrl ? pathOf(e.sourceUrl) : e.source}
                  </span>
                </li>
              ))}
              {phones.map((p) => (
                <li key={`p-${p.normalized ?? p.value}`} className="flex items-center justify-between gap-2">
                  <a href={`tel:${p.normalized ?? p.value}`} className="truncate text-zinc-200 hover:text-orange-300">
                    ☎ {p.value}
                  </a>
                  <span className="shrink-0 text-[10px] text-zinc-500">{p.sourceUrl ? pathOf(p.sourceUrl) : p.source}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!business && emails.length === 0 && phones.length === 0 && (
          <p className="text-zinc-500">Nothing useful could be extracted from this site.</p>
        )}

        {pages.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowPages((v) => !v)}
              className="text-[11px] font-medium text-zinc-500 transition hover:text-orange-300"
            >
              {showPages ? "▾" : "▸"} Scan details
            </button>
            {showPages && (
              <ul className="mt-2 space-y-1 animate-fade-in">
                {pages.map((p) => (
                  <li key={p.url} className="flex items-center justify-between gap-2 font-mono text-[10px]">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.ok ? "bg-emerald-400" : "bg-rose-500"}`} />
                      <span className="truncate text-zinc-400" title={p.url}>
                        {pathOf(p.url)}
                      </span>
                    </span>
                    <span className="shrink-0 text-zinc-500">
                      {p.ok
                        ? `${p.emails?.length ?? 0}✉ ${p.phones?.length ?? 0}☎`
                        : p.error || (p.status ? `HTTP ${p.status}` : "failed")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
