/**
 * OpenAI-compatible error envelope.
 *
 * Clients built against the OpenAI SDK parse this shape to produce typed
 * errors, so every failure the router emits — including its own — must use it.
 * A router that returns a bare `{"message": "..."}` is not a drop-in proxy.
 */
export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'upstream_error'
  | 'internal_error';

/** An error that carries the HTTP status and body the client should receive. */
export class RouterError extends Error {
  override readonly name = 'RouterError';

  constructor(
    readonly status: number,
    override readonly message: string,
    readonly type: ErrorType,
    readonly code: string | null = null,
    readonly param: string | null = null,
  ) {
    super(message);
  }

  toBody(): OpenAIErrorBody {
    return {
      error: {
        message: this.message,
        type: this.type,
        param: this.param,
        code: this.code,
      },
    };
  }

  /** The requested model alias is not present in the configuration. */
  static unknownModel(requested: string, available: string[]): RouterError {
    const list = available.length > 0 ? available.join(', ') : '(none configured)';
    return new RouterError(
      404,
      `The model \`${requested}\` does not exist or you do not have access to it. ` +
        `Configured models: ${list}`,
      'invalid_request_error',
      'model_not_found',
      'model',
    );
  }

  static badRequest(message: string, param: string | null = null): RouterError {
    return new RouterError(400, message, 'invalid_request_error', null, param);
  }

  static unauthorized(message: string): RouterError {
    return new RouterError(401, message, 'authentication_error', 'invalid_api_key');
  }

  /** The upstream could not be reached at all (DNS, connection refused, TLS). */
  static upstreamUnreachable(upstream: string, reason: string): RouterError {
    return new RouterError(
      502,
      `Upstream "${upstream}" is unreachable: ${reason}`,
      'upstream_error',
      'upstream_unreachable',
    );
  }

  /** The upstream accepted the connection but did not respond in time. */
  static upstreamTimeout(upstream: string, timeoutMs: number): RouterError {
    return new RouterError(
      504,
      `Upstream "${upstream}" did not respond within ${timeoutMs}ms.`,
      'upstream_error',
      'upstream_timeout',
    );
  }
}
