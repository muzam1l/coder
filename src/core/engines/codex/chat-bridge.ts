/**
 * Loopback bridge for custom models, alive as long as the Codex app-server
 * whose threads point at it. Reads no config and holds no secret: each
 * request names its upstream in the thread's provider headers, and the key
 * arrives as its authorization header, forwarded as-is.
 *
 * Chat endpoints (Ollama, llama.cpp, vLLM, OpenRouter, ...) get a translated
 * /chat/completions request with the reply streamed back as Responses SSE
 * events; native Responses endpoints get a verbatim passthrough.
 */
import crypto from 'node:crypto';
import http from 'node:http';

import { BRIDGE_HEADERS, endpointCandidates } from '../../config';
import type { CustomModelConfig } from '../../types';
import { jsonReplyPrompt } from '../../task/context/turn';

export interface ChatBridge {
  /** Loopback base URL; a custom model's provider base_url is `<url>/v1`. */
  url: string;
  close: () => Promise<void>;
}

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** Chat has no namespaces: a namespaced tool is the function `<namespace>__<tool>`. */
const flatName = (item: { name: string; namespace?: string }) =>
  item.namespace ? `${item.namespace}__${item.name}` : item.name;

/** Every function the request offers, namespaced ones flattened, by its chat name. */
function requestFunctions(body: any): Map<string, { name: string; namespace?: string; tool: any }> {
  const functions = new Map<string, { name: string; namespace?: string; tool: any }>();
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (tool?.type === 'function') functions.set(tool.name, { name: tool.name, tool });
    if (tool?.type === 'namespace' && Array.isArray(tool.tools))
      for (const inner of tool.tools)
        if (inner?.type === 'function')
          functions.set(flatName({ name: inner.name, namespace: tool.name }), {
            name: inner.name,
            namespace: tool.name,
            tool: inner,
          });
  }

  return functions;
}

/** Responses-request input items -> chat messages. */
function toChatMessages(body: any): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }
  const input = Array.isArray(body.input) ? body.input : [];
  for (const item of input) {
    switch (item?.type) {
      case 'message': {
        const text = Array.isArray(item.content)
          ? item.content.map((part: any) => part?.text ?? '').join('')
          : String(item.content ?? '');
        messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: text });
        break;
      }
      case 'function_call': {
        const call = {
          id: item.call_id,
          type: 'function' as const,
          function: { name: flatName(item), arguments: item.arguments ?? '{}' },
        };
        // Merge consecutive calls into one assistant message (parallel calls).
        const last = messages.at(-1);
        if (last?.role === 'assistant' && last.tool_calls) {
          last.tool_calls.push(call);
        } else {
          messages.push({ role: 'assistant', content: null, tool_calls: [call] });
        }
        break;
      }
      case 'function_call_output': {
        const output = item.output;
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
        });
        break;
      }
      default:
        // reasoning items and other server-side types have no chat equivalent.
        break;
    }
  }
  return messages;
}

/** Full Responses request body -> chat completions request body. */
function toChatRequest(body: any): Record<string, unknown> {
  const tools = [...requestFunctions(body)].map(([name, { tool }]) => ({
    type: 'function',
    function: {
      name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));
  const schema = body.text?.format;
  return {
    model: body.model,
    messages: toChatMessages(body),
    ...(tools.length ? { tools, tool_choice: body.tool_choice ?? 'auto' } : {}),
    ...(typeof body.parallel_tool_calls === 'boolean'
      ? { parallel_tool_calls: body.parallel_tool_calls }
      : {}),
    // OpenRouter's shape, which other chat endpoints ignore or take as is.
    ...(body.reasoning?.effort ? { reasoning: { effort: body.reasoning.effort } } : {}),
    ...(schema?.type === 'json_schema'
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: schema.name,
              schema: schema.schema,
              strict: schema.strict ?? false,
            },
          },
        }
      : {}),
    stream: true,
    stream_options: { include_usage: true },
  };
}

/** Accumulates one chat SSE stream and emits Responses SSE events. */
class StreamTranslator {
  private readonly send: (event: Record<string, unknown>) => void;
  private readonly model: string;
  private readonly functions: ReturnType<typeof requestFunctions>;
  private readonly responseId = `resp_bridge_${crypto.randomUUID()}`;
  private text = '';
  private textOpen = false;
  private toolCalls = new Map<number, { id: string; name: string; args: string }>();
  private usage: any = null;
  private buffer = '';

  constructor(
    model: string,
    functions: ReturnType<typeof requestFunctions>,
    send: (event: Record<string, unknown>) => void,
  ) {
    this.model = model;
    this.functions = functions;
    this.send = send;
    this.send({
      type: 'response.created',
      response: {
        id: this.responseId,
        object: 'response',
        status: 'in_progress',
        model,
        output: [],
      },
    });
  }

  /** Feed raw SSE bytes from the chat endpoint. */
  push(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const data = line.trim();
      if (!data.startsWith('data:')) {
        continue;
      }
      const payload = data.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (parsed.usage) {
        this.usage = parsed.usage;
      }
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) {
        continue;
      }
      if (typeof delta.content === 'string' && delta.content) {
        if (!this.textOpen) {
          this.textOpen = true;
          this.send({
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              type: 'message',
              id: 'msg_bridge_0',
              status: 'in_progress',
              role: 'assistant',
              content: [],
            },
          });
        }
        this.text += delta.content;
        this.send({
          type: 'response.output_text.delta',
          item_id: 'msg_bridge_0',
          output_index: 0,
          content_index: 0,
          delta: delta.content,
        });
      }
      for (const call of delta.tool_calls ?? []) {
        const slot = this.toolCalls.get(call.index) ?? { id: '', name: '', args: '' };
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.name += call.function.name;
        if (call.function?.arguments) slot.args += call.function.arguments;
        this.toolCalls.set(call.index, slot);
      }
    }
  }

  /** The chat stream ended: emit item completions and response.completed. */
  finish() {
    const output: unknown[] = [];
    if (this.text) {
      const item = {
        type: 'message',
        id: 'msg_bridge_0',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.text, annotations: [] }],
      };
      output.push(item);
      this.send({ type: 'response.output_item.done', output_index: 0, item });
    }
    let index = output.length;
    for (const call of this.toolCalls.values()) {
      const target = this.functions.get(call.name);
      const item = {
        type: 'function_call',
        id: `fc_bridge_${index}`,
        call_id: call.id || `call_bridge_${index}`,
        name: target?.name ?? call.name,
        ...(target?.namespace ? { namespace: target.namespace } : {}),
        arguments: call.args || '{}',
        status: 'completed',
      };
      output.push(item);
      this.send({ type: 'response.output_item.done', output_index: index, item });
      index += 1;
    }
    this.send({
      type: 'response.completed',
      response: {
        id: this.responseId,
        object: 'response',
        status: 'completed',
        model: this.model,
        output,
        usage: {
          input_tokens: this.usage?.prompt_tokens ?? 0,
          input_tokens_details: {
            cached_tokens: this.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          },
          output_tokens: this.usage?.completion_tokens ?? 0,
          output_tokens_details: {
            reasoning_tokens: this.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
          },
          total_tokens: this.usage?.total_tokens ?? 0,
        },
      },
    });
  }
}

/**
 * Start the bridge for one app-server. Listens on an ephemeral loopback port;
 * accepts Responses POSTs for any upstream its callers name.
 */
export async function startChatBridge(): Promise<ChatBridge> {
  // A bare-host baseUrl may serve the API under /v1 (endpointCandidates yields
  // both); a 404 on one candidate falls through to the next, and the first
  // candidate that responds with anything else is locked in for the upstream.
  const routes = new Map<string, { resolvedTarget: string | null; schemaSupported: boolean }>();

  async function forward(
    entry: Pick<CustomModelConfig, 'baseUrl' | 'wireApi'>,
    request: any,
    authorization?: string,
  ): Promise<Response> {
    const passthrough = entry.wireApi === 'responses';
    const targets = endpointCandidates(
      entry.baseUrl,
      passthrough ? 'responses' : 'chat/completions',
    );
    const key = `${entry.wireApi} ${entry.baseUrl}`;
    const route = routes.get(key) ?? { resolvedTarget: null, schemaSupported: true };
    routes.set(key, route);

    async function postUpstream(payload: string): Promise<Response> {
      const candidates = route.resolvedTarget ? [route.resolvedTarget] : targets;
      let last: Response | null = null;
      for (const url of candidates) {
        last = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(authorization ? { authorization } : {}),
          },
          body: payload,
        });
        if (last.status !== 404) {
          route.resolvedTarget = url;
          return last;
        }
      }
      return last!;
    }

    const format = request.text?.format;
    const native = passthrough ? request : toChatRequest(request);
    const fallback = () => {
      const instructions = jsonReplyPrompt(format.schema);
      if (passthrough) {
        const { format: ignored, ...text } = request.text;
        return {
          ...request,
          text,
          input: [
            ...(request.input ?? []),
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: instructions }],
            },
          ],
        };
      }
      const { response_format: ignored, ...chat } = native;
      return {
        ...chat,
        messages: [...toChatMessages(request), { role: 'user', content: instructions }],
      };
    };
    if (format?.type !== 'json_schema') return postUpstream(JSON.stringify(native));
    if (!route.schemaSupported) return postUpstream(JSON.stringify(fallback()));
    const response = await postUpstream(JSON.stringify(native));
    if (![400, 422, 501].includes(response.status)) return response;
    const detail = await response.clone().text();
    if (
      /(invalid.{0,30}schema|schema.{0,30}invalid|unsupported.{0,30}(keyword|constraint)|(keyword|constraint).{0,30}unsupported)/i.test(
        detail,
      ) ||
      !/(response_format|json_schema|text[.\s]format)/i.test(detail) ||
      !/(not supported|unsupported|unknown parameter|unrecognized|not available)/i.test(detail)
    )
      return response;
    route.schemaSupported = false;
    await response.body?.cancel();
    return postUpstream(JSON.stringify(fallback()));
  }

  // Loopback is not an auth boundary: any local process could otherwise spend
  // the upstream key. The bridge URL embeds a per-bridge secret path segment
  // and requests without it are rejected.
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    const header = (name: string) => [req.headers[name]].flat()[0];
    const baseUrl = header(BRIDGE_HEADERS.baseUrl);
    const wireApi = header(BRIDGE_HEADERS.wireApi) === 'responses' ? 'responses' : 'chat';
    if (
      req.method !== 'POST' ||
      !new RegExp(`^/${token}/v1/responses/*$`).test(req.url ?? '') ||
      !baseUrl
    ) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: `coder chat bridge: only POST /v1/responses with ${BRIDGE_HEADERS.baseUrl} is supported`,
          },
        }),
      );
      return;
    }
    const entry = { baseUrl, wireApi } as const;
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid JSON' } }));
        return;
      }
      try {
        const upstream = await forward(entry, parsed, req.headers.authorization);
        // Passthrough (native Responses endpoint): relay the reply bytes and status as-is.
        if (entry.wireApi === 'responses') {
          res.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') ?? 'application/json',
            'cache-control': 'no-store',
          });
          if (upstream.body) {
            for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
              res.write(chunk);
            }
          }
          res.end();
          return;
        }
        if (!upstream.ok || !upstream.body) {
          const detail = await upstream.text().catch(() => '');
          res.writeHead(upstream.status, { 'content-type': 'application/json' });
          res.end(
            detail || JSON.stringify({ error: { message: `upstream HTTP ${upstream.status}` } }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        const translator = new StreamTranslator(parsed.model, requestFunctions(parsed), event =>
          res.write(`data: ${JSON.stringify(event)}\n\n`),
        );
        const decoder = new TextDecoder();
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
          translator.push(decoder.decode(chunk, { stream: true }));
        }
        translator.finish();
        res.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `coder chat bridge: ${message}` } }));
      }
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/${token}`,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        // Don't hold the worker open for idle keep-alive sockets.
        server.closeAllConnections?.();
      }),
  };
}
