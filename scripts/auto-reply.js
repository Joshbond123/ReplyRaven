import { createRuntime, writeSummary } from './lib/runtime.js';
import { parseSecretKeys, runAutoReply } from './lib/automation.js';
try {
  const keys = parseSecretKeys(process.env.AI_KEYS_JSON);
  const runtime = await createRuntime();
  const result = await runAutoReply({ ...runtime, keys });
  await writeSummary('ReplyRaven · Thoughtful replies', [
    `Automation paused: ${result.paused}`,
    `Eligible 4–5 star reviews: ${result.eligible}`,
    `Replies sent: ${result.replied}`,
    `Skipped: ${result.skipped}`,
    `Errors: ${result.errors.length}`,
    ...result.errors.map((error) => runtime.redact(error)),
  ]);
  if (result.errors.length) process.exitCode = 1;
} catch (error) {
  console.error(`Auto-reply could not start: ${error.message}`);
  process.exitCode = 1;
}
