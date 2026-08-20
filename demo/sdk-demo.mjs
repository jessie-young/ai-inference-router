/**
 * Proves the router is a genuine drop-in for the OpenAI API.
 *
 * This is the compatibility test that matters: the official SDK, unmodified,
 * with only `baseURL` changed. If this works, any OpenAI-compatible client
 * works — LangChain, LlamaIndex, Vercel AI SDK, existing application code.
 *
 *   npm install --no-save openai
 *   node demo/sdk-demo.mjs
 */
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: process.env.ROUTER_URL ?? 'http://127.0.0.1:8080/v1',
  apiKey: process.env.ROUTER_API_KEY ?? 'not-used',
});

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

console.log(dim('  Using the official `openai` package; only baseURL differs.\n'));

// 1. Non-streaming completion.
const completion = await client.chat.completions.create({
  model: 'router/gemma4',
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  max_tokens: 20,
});
console.log('  chat.completions.create() →', green(JSON.stringify(completion.choices[0].message.content)));
console.log(dim(`    model field: ${completion.model} (the alias, as expected)`));

// 2. Streaming.
process.stdout.write('  streaming → ' + green(''));
const stream = await client.chat.completions.create({
  model: 'router/mistral-small',
  messages: [{ role: 'user', content: 'Say: hello world' }],
  stream: true,
  max_tokens: 30,
});
let text = '';
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content ?? '';
  text += delta;
  process.stdout.write(green(delta));
}
console.log();

// 3. Typed errors — the SDK raises NotFoundError, not a generic failure.
try {
  await client.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'hi' }],
  });
  console.log('  ERROR: expected this to throw');
} catch (err) {
  console.log(`  unknown model → SDK raised ${green(err.constructor.name)} (status ${err.status})`);
  console.log(dim('    The SDK parsed our error envelope into its own typed error.'));
}

// 4. Model listing.
const models = await client.models.list();
console.log('  models.list() →', green(models.data.map((m) => m.id).join(', ')));
