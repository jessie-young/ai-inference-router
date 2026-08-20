import { z } from 'zod';
import { RouterError } from '../router/errors.js';

/**
 * Validation of incoming Chat Completions requests.
 *
 * Deliberately permissive. The router validates the fields it actually routes
 * on — `model`, `messages`, `stream` — and passes everything else through
 * untouched via `.passthrough()`. Strict validation of the full OpenAI schema
 * would mean this proxy breaks every time a provider ships a new parameter,
 * which is the opposite of what a routing layer is for.
 */

const messageSchema = z
  .object({
    role: z.string().min(1),
    // Content may be a string, an array of content parts (vision, audio), or
    // null for assistant messages that only carry tool calls.
    content: z.unknown().optional(),
  })
  .passthrough();

export const chatCompletionRequestSchema = z
  .object({
    model: z.string({ required_error: 'you must provide a model parameter' }).min(1),
    messages: z
      .array(messageSchema)
      .min(1, 'messages must contain at least one message'),
    // OpenAI declares `stream` as `nullable: true, default: false` in its
    // OpenAPI spec, so an explicit JSON null is a valid way to say "not
    // streaming". The first-party SDKs omit the field instead, but clients
    // that serialize unset optionals as null (Go/Java zero values, JSON
    // templating, some wrappers) do send it. Rejecting it would be stricter
    // than the API we claim to be compatible with.
    stream: z.boolean().nullish(),
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

/**
 * Parse a request body, converting any failure into an OpenAI-shaped 400.
 */
export function parseChatCompletionRequest(body: unknown): ChatCompletionRequest {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw RouterError.badRequest('Request body must be a JSON object.');
  }

  const result = chatCompletionRequestSchema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const param = issue && issue.path.length > 0 ? issue.path.join('.') : null;
    const message = issue ? issue.message : 'Invalid request body.';
    throw RouterError.badRequest(message, param);
  }

  return result.data;
}
