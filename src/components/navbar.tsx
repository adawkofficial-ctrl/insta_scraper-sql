"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getMe, logoutUser, type AuthUser } from "@/lib/api/auth";

export function Navbar({ onNewCampaign }: { onNewCampaign?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
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

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2.5 text-white transition hover:opacity-90">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-tr from-amber-500 via-rose-500 to-purple-600 shadow-md shadow-rose-500/20">
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
              <span className="text-base font-bold tracking-tight text-zinc-100">
                Insta<span className="text-rose-500">Scraper</span>
              </span>
              <span className="text-[10px] font-medium tracking-wider uppercase text-zinc-400">
                Campaign & Lead Engine
              </span>
            </div>
          </Link>

          <nav className="hidden items-center gap-1 sm:flex">
            <Link
              href="/"
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                pathname === "/"
                  ? "bg-zinc-800/80 text-white"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              Campaigns
            </Link>
            <Link
              href="/settings"
              id="nav-settings-link"
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                pathname === "/settings"
                  ? "bg-zinc-800/80 text-white"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              Settings
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {onNewCampaign && (
            <button
              onClick={onNewCampaign}
              id="new-campaign-btn"
              className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-500 focus:ring-offset-2 focus:ring-offset-zinc-900"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              <span>New Campaign</span>
            </button>
          )}

          {!loadingUser && (
            user ? (
              <div className="flex items-center gap-3 border-l border-zinc-800 pl-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-tr from-rose-500 to-purple-600 text-xs font-bold text-white shadow-sm">
                    {user.name ? user.name.charAt(0).toUpperCase() : user.email.charAt(0).toUpperCase()}
                  </div>
                  <div className="hidden flex-col md:flex">
                    <span className="text-xs font-medium text-zinc-200">
                      {user.name || user.email.split("@")[0]}
                    </span>
                    <span className="text-[10px] text-zinc-400">
                      {user.email}
                    </span>
                  </div>
                </div>
                <button
                  onClick={handleLogout}
                  id="logout-btn"
                  title="Sign out"
                  className="rounded-lg border border-zinc-700/80 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-400 transition hover:border-zinc-600 hover:bg-zinc-800 hover:text-white"
                >
                  Sign Out
                </button>
              </div>
            ) : (
              <Link
                href="/login"
                id="sign-in-btn"
                className="rounded-lg border border-zinc-700/80 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800 hover:text-white"
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

