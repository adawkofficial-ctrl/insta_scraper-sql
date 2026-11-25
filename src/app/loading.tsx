export default function RootLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-app">
      <div className="flex flex-col items-center gap-4 animate-fade-in">
        <div className="relative h-10 w-10">
          <div className="absolute inset-0 rounded-full border-2 border-zinc-800" />
          <div className="absolute inset-0 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
        </div>
        <span className="text-[11px] font-semibold tracking-[0.2em] text-zinc-400 uppercase">Loading</span>
      </div>
    </div>
  );
}
