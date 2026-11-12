"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { loginUser, getMe } from "@/lib/api/auth";

export function getSafeRedirect(rawRedirect: string | null): string {
  if (!rawRedirect) return "/";

  // Prevent open redirect attacks (protocols, scheme-relative //evil.com, etc.)
  const trimmed = rawRedirect.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/\\") ||
    trimmed.includes("://")
  ) {
    return "/";
  }

  // Prevent redirect loops back to login/register
  const urlPath = trimmed.split("?")[0].toLowerCase();
  if (urlPath === "/login" || urlPath === "/register") {
    return "/";
  }

  return trimmed;
}

type AuthCardProps = {
  initialMode?: "login" | "register";
};

export function AuthCard({ initialMode: _initialMode }: AuthCardProps = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaultAdmin, setDefaultAdmin] = useState<{ email: string; password?: string } | null>(null);

  const redirectPath = getSafeRedirect(searchParams.get("redirect"));
  const isDevMode = process.env.NODE_ENV !== "production";

  // Fetch configured default admin info for dev helper
  useEffect(() => {
    let isMounted = true;
    fetch("/api/auth/default-admin")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (isMounted && data?.email) {
          setDefaultAdmin(data);
        }
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, []);

  // Check if user is already authenticated
  useEffect(() => {
    let isMounted = true;
    getMe().then(({ user }) => {
      if (isMounted && user) {
        router.replace(redirectPath);
      }
    });
    return () => {
      isMounted = false;
    };
  }, [router, redirectPath]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Please enter your email address.");
      return;
    }

    if (!password) {
      setError("Please enter your password.");
      return;
    }

    setLoading(true);

    try {
      await loginUser({ email: trimmedEmail, password });
      // Hard redirect / full navigation ensures auth state and cookies are fresh
      window.location.href = redirectPath;
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("An unexpected authentication error occurred.");
      }
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-4 py-12 sm:px-6 lg:px-8">
      <div className="w-full max-w-md space-y-8">
        {/* Brand Header */}
        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-tr from-amber-500 via-rose-500 to-purple-600 shadow-lg shadow-rose-500/20">
            <svg
              className="h-6 w-6 text-white"
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
          <h1 className="mt-4 text-3xl font-extrabold tracking-tight text-white">
            Insta<span className="text-rose-500">Scraper</span>
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Sign in to manage your campaigns, outreach, and leads
          </p>
        </div>

        {/* Card Container */}
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/60 p-8 shadow-xl backdrop-blur-sm">
          {/* Error Message */}
          {error && (
            <div
              id="auth-error-alert"
              className="mb-4 flex items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-950/40 p-3 text-sm text-red-300"
            >
              <svg
                className="mt-0.5 h-4 w-4 shrink-0 text-red-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <div className="flex-1">{error}</div>
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-red-400 hover:text-red-200"
                title="Dismiss"
              >
                &times;
              </button>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-xs font-semibold uppercase tracking-wider text-zinc-400"
              >
                Email Address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={defaultAdmin?.email || "admin@instascraper.com"}
                className="mt-1.5 block w-full rounded-lg border border-zinc-700/80 bg-zinc-950 px-3.5 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label
                  htmlFor="password"
                  className="block text-xs font-semibold uppercase tracking-wider text-zinc-400"
                >
                  Password
                </label>
              </div>
              <div className="relative mt-1.5">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="block w-full rounded-lg border border-zinc-700/80 bg-zinc-950 px-3.5 py-2.5 pr-10 text-sm text-white placeholder-zinc-500 focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-zinc-400 hover:text-zinc-200"
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" />
                    </svg>
                  ) : (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              id="submit-auth-btn"
              disabled={loading}
              className="mt-6 flex w-full items-center justify-center rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md transition hover:bg-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-500 focus:ring-offset-2 focus:ring-offset-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <div className="flex items-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span>Signing In...</span>
                </div>
              ) : (
                "Sign In"
              )}
            </button>
          </form>

          {/* Quick Fill Helper for Demo / Dev */}
          {isDevMode && (
            <div className="mt-6 border-t border-zinc-800 pt-4 text-center text-xs text-zinc-500">
              <p>Default Admin Account:</p>
              <button
                type="button"
                onClick={() => {
                  setEmail(defaultAdmin?.email || "admin@instascraper.com");
                  setPassword(defaultAdmin?.password || "AdminPass2026!Secure");
                }}
                className="mt-1 font-mono text-xs text-rose-400 hover:text-rose-300 hover:underline"
              >
                {defaultAdmin?.email || "admin@instascraper.com"} (auto-fill)
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
