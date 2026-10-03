export default function RootLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-rose-500 border-t-transparent" />
        <span className="text-xs font-medium tracking-wider text-zinc-400 uppercase">Loading...</span>
      </div>
    </div>
  );
}
