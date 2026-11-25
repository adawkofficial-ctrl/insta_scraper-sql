"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getMe, logoutUser, type AuthUser } from "@/lib/api/auth";

export function Navbar({ onNewCampaign }: { onNewCampaign?: () => void }) {
  const pathname = usePathname();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  useEffect(() => {
    let isMounted = true;
    getMe()
      .then(({ user }) => {
        if (isMounted) {
          setUser(user);
          setLoadingUser(false);
        }
      })
      .catch(() => {
        if (isMounted) {
          setUser(null);
          setLoadingUser(false);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [pathname]);

  const handleLogout = async () => {
    try {
      await logoutUser();
      setUser(null);
      window.location.href = "/login";
    } catch {
      window.location.href = "/login";
    }
  };

  const isCampaignsActive = pathname === "/" || pathname.startsWith("/campaigns");
  const isSettingsActive = pathname.startsWith("/settings");

  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-black/75 backdrop-blur-xl after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-gradient-to-r after:from-transparent after:via-orange-500/50 after:to-transparent">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link href="/" className="group flex items-center gap-2.5 transition">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-gradient shadow-lg shadow-orange-500/30 ring-1 ring-orange-300/30 transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3">
              <svg
                className="h-5 w-5 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                />
              </svg>
            </div>
            <div className="flex flex-col">
              <span className="text-base font-bold tracking-tight text-primary">
                Insta<span className="text-brand-gradient">Scraper</span>
              </span>
              <span className="text-[10px] font-semibold tracking-wider uppercase text-muted">
                Campaign & Lead Engine
              </span>
            </div>
          </Link>

          <nav className="hidden items-center gap-1 sm:flex">
            <Link
              href="/"
              className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all duration-150 ${
                isCampaignsActive
                  ? "bg-orange-500/12 text-orange-300 font-semibold ring-1 ring-inset ring-orange-500/30"
                  : "text-zinc-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              Campaigns
            </Link>
            <Link
              href="/settings"
              id="nav-settings-link"
              className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all duration-150 ${
                isSettingsActive
                  ? "bg-orange-500/12 text-orange-300 font-semibold ring-1 ring-inset ring-orange-500/30"
                  : "text-zinc-400 hover:bg-white/5 hover:text-white"
              }`}
            >
              Settings
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-2.5 sm:gap-3">
          {onNewCampaign && (
            <button
              onClick={onNewCampaign}
              id="new-campaign-btn"
              className="inline-flex items-center gap-2 rounded-lg bg-brand-gradient px-3.5 py-2 text-sm font-semibold text-white border border-orange-400/40 shadow-[0_6px_20px_-8px_rgba(255,122,26,0.8)] transition-all duration-200 hover:brightness-110 hover:-translate-y-px focus:outline-none focus:ring-2 focus:ring-orange-500/60 cursor-pointer"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              <span>New Campaign</span>
            </button>
          )}

          {!loadingUser && (
            user ? (
              <div className="flex items-center gap-2.5 sm:gap-3 border-l border-subtle pl-2.5 sm:pl-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-gradient text-xs font-bold text-white shadow-sm ring-2 ring-black ring-offset-1 ring-offset-orange-500/40">
                    {user.name ? user.name.charAt(0).toUpperCase() : user.email.charAt(0).toUpperCase()}
                  </div>
                  <div className="hidden flex-col md:flex">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-primary">
                        {user.name || user.email.split("@")[0]}
                      </span>
                      {user.role === "ADMIN" && (
                        <span className="rounded-full bg-indigo-500/15 border border-indigo-500/30 px-1.5 py-0.2 text-[9px] font-semibold text-indigo-600 dark:text-indigo-400">
                          Admin
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-muted">
                      {user.email}
                    </span>
                  </div>
                </div>
                <button
                  onClick={handleLogout}
                  id="logout-btn"
                  title="Sign out"
                  className="rounded-lg border border-subtle bg-surface hover:bg-surface-hover px-2.5 py-1.5 text-xs font-medium text-secondary transition-all duration-150 hover:text-primary cursor-pointer shadow-card"
                >
                  Sign Out
                </button>
              </div>
            ) : (
              <Link
                href="/login"
                id="sign-in-btn"
                className="rounded-lg border border-subtle bg-surface hover:bg-surface-hover px-3 py-1.5 text-xs font-medium text-secondary transition-all duration-150 hover:text-primary shadow-card"
              >
                Sign In
              </Link>
            )
          )}
        </div>
      </div>
    </header>
  );
}
