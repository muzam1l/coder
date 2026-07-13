/**
 * Responses -> Chat Completions bridge for custom models. Codex (>= 0.144)
 * only speaks the OpenAI Responses API, while most OpenAI-compatible endpoints
 * (Ollama, llama.cpp, vLLM, OpenRouter, ...) only speak chat completions. The
 * bridge is a loopback HTTP server, alive for the duration of one turn: codex
 * POSTs /responses to it, it forwards a translated /chat/completions request
 * to the user's endpoint (injecting the API key from the configured env var)
 * and streams the reply back as Responses SSE events.
 */
import http from 'node:http';
import process from 'node:process';

import { normalizeBaseUrl } from './config.js';
import type { CustomModelConfig } from './types.js';

export interface ChatBridge {
  /** Loopback base URL to hand codex as the provider base_url (ends in /v1). */
  url: string;
  close: () => Promise<void>;
}

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

let responseCounter = 0;

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
          function: { name: item.name, arguments: item.arguments ?? '{}' },
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
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter((tool: any) => tool?.type === 'function')
    .map((tool: any) => ({
      type: 'function',
      function: {
        name: tool.name,
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
    ...(schema?.type === 'json_schema'
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: { name: schema.name, schema: schema.schema, strict: schema.strict ?? false },
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
  private readonly responseId = `resp_bridge_${++responseCounter}`;
  private text = '';
  private textOpen = false;
  private toolCalls = new Map<number, { id: string; name: string; args: string }>();
  private usage: any = null;
  private buffer = '';

  constructor(model: string, send: (event: Record<string, unknown>) => void) {
    this.model = model;
    this.send = send;
    this.send({
      type: 'response.created',
      response: { id: this.responseId, object: 'response', status: 'in_progress', model, output: [] },
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
            item: { type: 'message', id: 'msg_bridge_0', status: 'in_progress', role: 'assistant', content: [] },
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
      const item = {
        type: 'function_call',
        id: `fc_bridge_${index}`,
        call_id: call.id || `call_bridge_${index}`,
        name: call.name,
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
          input_tokens_details: { cached_tokens: this.usage?.prompt_tokens_details?.cached_tokens ?? 0 },
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
 * Start a bridge for one custom model. Listens on an ephemeral loopback port;
 * accepts POSTs to any path ending in /responses (providers and codex versions
 * vary the prefix) and rejects everything else.
 */
export async function startChatBridge(entry: CustomModelConfig): Promise<ChatBridge> {
  const target = `${normalizeBaseUrl(entry.baseUrl)}/chat/completions`;
  const apiKey = entry.envKey ? process.env[entry.envKey] : undefined;

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.replace(/\/+$/, '').endsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'coder chat bridge: only POST /responses is supported' } }));
      return;
    }
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
        const upstream = await fetch(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(toChatRequest(parsed)),
        });
        if (!upstream.ok || !upstream.body) {
          const detail = await upstream.text().catch(() => '');
          res.writeHead(upstream.status, { 'content-type': 'application/json' });
          res.end(detail || JSON.stringify({ error: { message: `upstream HTTP ${upstream.status}` } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        const translator = new StreamTranslator(parsed.model, event =>
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
    url: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        // Don't hold the worker open for idle keep-alive sockets.
        server.closeAllConnections?.();
      }),
  };
}
