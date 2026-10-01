import { createRuntime, writeSummary } from './lib/runtime.js';
import { runSync } from './lib/automation.js';
try {
  const runtime = await createRuntime();
  const result = await runSync(runtime);
  await writeSummary('ReplyRaven · Review sync', [
    `Active businesses: ${result.businesses}`,
    `Successfully synced: ${result.synced}`,
    `New reviews: ${result.newReviews}`,
    `Errors: ${result.errors.length}`,
    ...result.errors.map((error) => runtime.redact(error)),
  ]);
  if (result.errors.length) process.exitCode = 1;
} catch (error) {
  console.error(`Sync could not start: ${error.message}`);
  process.exitCode = 1;
}
