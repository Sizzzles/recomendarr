export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return;
  }

  const runtime = globalThis as typeof globalThis & { __recomendarrProcessStartedAt?: string };
  runtime.__recomendarrProcessStartedAt ||= new Date().toISOString();
  const { recoverEngineRunsAtStartup } = await import('./lib/engine-run-tracker');
  recoverEngineRunsAtStartup(runtime.__recomendarrProcessStartedAt);

  const { ensureSchedulerWatcher, syncRecommendationScheduler } = await import('./lib/scheduler');
  syncRecommendationScheduler();
  ensureSchedulerWatcher();
}
