/**
 * Runs once per server start. Boots the in-process outreach scheduler
 * (resumes RUNNING bulk jobs and sends due follow-ups) on the Node runtime.
 *
 * next.config.ts aliases this Node-only module to an empty module for the
 * browser/edge compilations, so instrumentation can import it normally without
 * dragging Prisma/Playwright/Apify into those bundles.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startOutreachScheduler } = await import("@/lib/services/scheduler/outreach-scheduler");
  startOutreachScheduler();
}
