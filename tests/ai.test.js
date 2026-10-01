import test from 'node:test';
import assert from 'node:assert/strict';
import { AIKeyRotator } from '../lib/ai.js';
import { SDKAIKeyRotator } from '../scripts/lib/providers.js';
import { parseSecretKeys } from '../scripts/lib/automation.js';
import { aiKey, business, review, response } from './helpers.js';
test('round-robin persists rotation and skips inactive keys', () => {
  const engine = new AIKeyRotator([
    aiKey,
    { ...aiKey, id: 'disabled', is_active: 'FALSE' },
    { ...aiKey, id: 'two' },
  ]);
  assert.deepEqual(
    [engine.getNextAIKey().id, engine.getNextAIKey().id, engine.getNextAIKey().id],
    ['key-1', 'two', 'key-1'],
  );
});
test('a 429 moves to the next key and accounts for each attempt', async () => {
  const attempts = [],
    rotations = [],
    calls = [];
  const engine = new AIKeyRotator(
    [aiKey, { ...aiKey, id: 'key-2', api_key: 'other-key', provider: 'groq' }],
    {
      onAttempt: async (key, error) => attempts.push([key.id, error?.status]),
      onRotate: async (index) => rotations.push(index),
      fetcher: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1
          ? response({ error: { message: 'Rate limited' } }, 429)
          : response({ choices: [{ message: { content: 'A warm thank-you.' } }] });
      },
    },
  );
  const result = await engine.generate(review, business);
  assert.equal(result.reply, 'A warm thank-you.');
  assert.equal(result.key.id, 'key-2');
  assert.deepEqual(attempts, [
    ['key-1', 429],
    ['key-2', undefined],
  ]);
  assert.deepEqual(rotations, [1, 0]);
  assert.match(calls[1].url, /groq/);
  assert.match(JSON.parse(calls[1].init.body).messages[1].content, /A café/);
});
test('all failed keys produce an explicit failure, not a fake reply', async () => {
  let calls = 0;
  const engine = new AIKeyRotator([aiKey, { ...aiKey, id: 'two' }], {
    fetcher: async () => {
      calls++;
      return response({ error: { message: 'Quota' } }, 429);
    },
  });
  await assert.rejects(engine.generate(review, business), /All active AI keys failed/);
  assert.equal(calls, 2);
});
test('no keys fail without provider requests', async () => {
  const engine = new AIKeyRotator([{ ...aiKey, is_active: 'FALSE' }]);
  await assert.rejects(engine.generate(review, business), /No active AI keys/);
  assert.throws(() => engine.getNextAIKey(), /No active/);
});
test('Gemini uses API key header and parses generated text', async () => {
  let call;
  const engine = new AIKeyRotator([{ ...aiKey, provider: 'gemini', model_name: 'gemini-2.5-flash' }], {
    fetcher: async (url, init) => {
      call = { url, init };
      return response({ candidates: [{ content: { parts: [{ text: 'Thanks!' }] } }] });
    },
  });
  assert.equal((await engine.generate(review, business)).reply, 'Thanks!');
  assert.equal(call.init.headers['x-goog-api-key'], aiKey.api_key);
  assert.equal(JSON.parse(call.init.body).generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.ok(!call.url.includes(aiKey.api_key));
});
test('Anthropic is supported with explicit direct-browser opt-in', async () => {
  let headers;
  const engine = new AIKeyRotator(
    [{ ...aiKey, provider: 'anthropic', model_name: 'claude-sonnet-4-20250514' }],
    {
      fetcher: async (url, init) => {
        headers = init.headers;
        return response({ content: [{ type: 'text', text: 'Thanks, Alice.' }] });
      },
    },
  );
  assert.equal((await engine.generate(review, business)).reply, 'Thanks, Alice.');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
});
test('empty/oversized responses fail over without being posted', async () => {
  for (const text of ['', 'x'.repeat(4097)]) {
    const engine = new AIKeyRotator([aiKey], {
      fetcher: async () => response({ choices: [{ message: { content: text } }] }),
    });
    await assert.rejects(engine.generate(review, business), /All active/);
  }
});
test('relay can use metadata-only rows without browser API keys', async () => {
  const engine = new AIKeyRotator([{ ...aiKey, api_key: '' }], {
    proxy: async (data) => {
      assert.equal(data.keyId, 'key-1');
      assert.match(data.prompt, /Loved it/);
      return { reply: 'From a private relay.' };
    },
  });
  assert.equal((await engine.generate(review, business)).reply, 'From a private relay.');
});
test('Actions OpenAI SDK supports failover without SDK auto-retries', async () => {
  let calls = 0;
  const engine = new SDKAIKeyRotator([aiKey, { ...aiKey, id: 'second' }], {
    fetcher: async () => {
      calls++;
      return calls === 1
        ? response({ error: { message: 'rate limit', type: 'rate_limit_error' } }, 429)
        : response({ choices: [{ message: { content: 'SDK reply' } }] });
    },
  });
  assert.equal((await engine.generate(review, business)).reply, 'SDK reply');
  assert.equal(calls, 2);
});
test('secret parsing validates JSON, normalizes aliases, and preserves stable IDs', () => {
  assert.throws(() => parseSecretKeys('bad'), /valid JSON/);
  assert.throws(() => parseSecretKeys('{}'), /array/);
  assert.throws(() => parseSecretKeys('[]'), /no active/);
  assert.throws(() => parseSecretKeys(JSON.stringify([aiKey, aiKey])), /unique/);
  const keys = parseSecretKeys(JSON.stringify([{ provider: 'gpt', key: 'token', model: 'gpt-4o-mini' }]));
  assert.equal(keys[0].id, 'secret-1');
  assert.equal(keys[0].api_key, 'token');
  assert.equal(keys[0].is_active, 'TRUE');
});
test('corrupt rotation indices are normalized safely', () => {
  for (const index of [-1, NaN, Infinity]) {
    const engine = new AIKeyRotator([aiKey], { index });
    assert.equal(engine.getNextAIKey().id, aiKey.id);
  }
});
