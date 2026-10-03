import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-4 text-center">
      <div className="mx-auto max-w-md space-y-6 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-8 shadow-2xl backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-800 text-zinc-400 ring-1 ring-zinc-700">
          <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>

        <div>
          <span className="text-xs font-bold uppercase tracking-widest text-rose-500">404 Error</span>
          <h2 className="mt-1 text-2xl font-bold text-white">Resource Not Found</h2>
          <p className="mt-2 text-sm text-zinc-400">
            The page or resource you requested does not exist or you do not have permission to view it.
          </p>
        </div>

        <div>
          <Link
            href="/"
            className="inline-flex rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-500 focus:ring-offset-2 focus:ring-offset-zinc-900"
          >
            Back to Campaigns
          </Link>
        </div>
      </div>
    </div>
  );
}
