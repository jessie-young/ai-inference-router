/**
 * A fake LLM provider for demoing the router's failure handling.
 *
 * Real providers fail on their own schedule, which is useless in a demo. This
 * server fails on demand: each route reproduces one upstream failure mode so
 * you can show the router's response to it deterministically.
 *
 *   node demo/mock-upstream.mjs [port]     (default 9090)
 *
 * Pair it with demo/config.demo.yaml, which points router/* aliases here.
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 9090);
let flakyCallCount = 0;

/** A minimal valid OpenAI response, so success looks real. */
const ok = (model) => ({
  id: 'chatcmpl-mock-' + Math.random().toString(36).slice(2, 10),
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{
    index: 0,
    message: { role: 'assistant', content: 'Hello from the mock upstream!' },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
});

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
    const model = body.model ?? 'mock/model';
    const path = req.url ?? '';

    const stamp = new Date().toISOString();
    console.log(`[mock ${stamp}] ${req.method} ${path}  model=${model}`);

    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // --- Failure modes, selected by URL path ---

    if (path.includes('/fail-500')) {
      console.log('   → responding 500 (server error)');
      return json(500, { error: { message: 'Mock upstream exploded', type: 'server_error' } });
    }

    if (path.includes('/fail-429')) {
      console.log('   → responding 429 (rate limited)');
      return json(429, {
        error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
      });
    }

    if (path.includes('/fail-401')) {
      console.log('   → responding 401 (bad upstream credentials)');
      return json(401, { error: { message: 'Invalid API key', type: 'authentication_error' } });
    }

    if (path.includes('/timeout')) {
      console.log('   → hanging forever (router should time out and return 504)');
      return; // never respond
    }

    if (path.includes('/garbage')) {
      console.log('   → responding 200 with non-JSON HTML (router should return 502)');
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body>502 Bad Gateway</body></html>');
    }

    if (path.includes('/flaky')) {
      // Fails twice, then succeeds — demonstrates retry with backoff.
      flakyCallCount++;
      if (flakyCallCount < 3) {
        console.log(`   → attempt ${flakyCallCount}: responding 503 (router should retry)`);
        return json(503, { error: { message: 'Service temporarily unavailable', type: 'server_error' } });
      }
      console.log(`   → attempt ${flakyCallCount}: responding 200 (retry succeeded)`);
      flakyCallCount = 0;
      return json(200, ok(model));
    }

    if (path.includes('/truncate')) {
      // Streams two frames then kills the socket, with no [DONE].
      console.log('   → streaming 2 frames then destroying the socket');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: {"id":"mock","object":"chat.completion.chunk","model":"${model}","choices":[{"index":0,"delta":{"content":"Par"}}]}\n\n`);
      res.write(`data: {"id":"mock","object":"chat.completion.chunk","model":"${model}","choices":[{"index":0,"delta":{"content":"tial"}}]}\n\n`);
      return setTimeout(() => res.socket?.destroy(), 100);
    }

    // --- Success paths ---

    if (body.stream) {
      console.log('   → streaming a normal response');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const words = ['Hello', ' from', ' the', ' mock', ' upstream', '!'];
      for (const w of words) {
        res.write(`data: {"id":"mock","object":"chat.completion.chunk","model":"${model}","choices":[{"index":0,"delta":{"content":"${w}"}}]}\n\n`);
        await new Promise((r) => setTimeout(r, 120));
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    console.log('   → responding 200 (success)');
    return json(200, ok(model));
  });
});

server.listen(port, () => {
  console.log(`Mock upstream listening on http://127.0.0.1:${port}`);
  console.log('Failure modes: /fail-500 /fail-429 /fail-401 /timeout /garbage /flaky /truncate');
});
