import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface StubResponder {
  json(status: number, body: unknown): void;
  text(status: number, body: string, contentType?: string): void;
  sse(chunks: string[], delayMs?: number): Promise<void>;
  hang(): void;
}

export interface StubHandler {
  (req: StubRequest, respond: StubResponder): void | Promise<void>;
}

/**
 * A real HTTP server standing in for an upstream provider.
 *
 * Using a real socket rather than a mocked `fetch` means the tests exercise
 * genuine network behavior — headers actually sent, connections actually
 * refused, streams actually chunked — which is where proxy bugs live.
 */
export class StubUpstream {
  private server: Server;
  readonly requests: StubRequest[] = [];
  private handler: StubHandler;

  private constructor(server: Server, handler: StubHandler) {
    this.server = server;
    this.handler = handler;
  }

  static async start(handler: StubHandler): Promise<StubUpstream> {
    let stub: StubUpstream;

    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try {
          body = raw.length > 0 ? JSON.parse(raw) : undefined;
        } catch {
          body = raw;
        }

        const captured: StubRequest = {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          body,
        };
        stub.requests.push(captured);

        const responder: StubResponder = {
          json(status, payload) {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
          },
          text(status, payload, contentType = 'text/plain') {
            res.writeHead(status, { 'content-type': contentType });
            res.end(payload);
          },
          async sse(sseChunks, delayMs = 0) {
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
            });
            for (const chunk of sseChunks) {
              res.write(chunk);
              if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            }
            res.end();
          },
          hang() {
            // Deliberately never respond, to exercise the client timeout.
          },
        };

        void stub.handler(captured, responder);
      });
    });

    stub = new StubUpstream(server, handler);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return stub;
  }

  /** Swap the handler mid-test, e.g. to fail once then succeed. */
  setHandler(handler: StubHandler): void {
    this.handler = handler;
  }

  get baseUrl(): string {
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/v1`;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }
}

/** A minimal, valid OpenAI Chat Completions response. */
export function completionResponse(model: string, content = 'Hello!'): Record<string, unknown> {
  return {
    id: 'chatcmpl-test123',
    object: 'chat.completion',
    created: 1700000000,
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 },
  };
}
