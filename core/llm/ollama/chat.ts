// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { HELM_OLLAMA_PORT } from "./env.js";
import type { ChatMessage, ChatStreamChunk } from "../../../shared/llm.js";

/**
 * HTTP client for Helm's private Ollama /api/chat endpoint.
 *
 * Always talks to 127.0.0.1:<HELM_OLLAMA_PORT>. Never the system Ollama on
 * 11434. Never anywhere remote. The planner uses this; nothing else should
 * need to call Ollama HTTP directly.
 */

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  /** Force structured-JSON output. Ollama refuses to emit non-JSON text. */
  json?: boolean;
  /** Sampling temperature. Default 0.0 for deterministic planner output. */
  temperature?: number;
  /** Optional cap on completion tokens. */
  numPredict?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

export interface ChatResult {
  /** The model name as Ollama reported it. */
  model: string;
  /** Assembled assistant message. */
  content: string;
  /** Token usage if Ollama reported it. */
  tokens?: {
    promptEval?: number;
    eval?: number;
    totalMs?: number;
  };
}

/**
 * Non-streaming chat. Returns the assembled assistant message.
 *
 * Throws on transport failure or non-2xx response, with a message that
 * distinguishes "model not installed" from generic network errors so the
 * caller can give the user a useful next step.
 */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const url = `http://127.0.0.1:${HELM_OLLAMA_PORT}/api/chat`;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
    options: {
      temperature: opts.temperature ?? 0.0,
      ...(opts.numPredict !== undefined ? { num_predict: opts.numPredict } : {}),
    },
  };
  if (opts.json) body["format"] = "json";

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 60000
  );

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    throw new Error(
      `chat: cannot reach Helm's private Ollama at ${url}. Is it running? (helm ollama-start). ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  clearTimeout(timeout);

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404 && /model.*not found|pull/i.test(text)) {
      throw new Error(
        `chat: model "${opts.model}" is not installed in Helm's private Ollama. ` +
        `Run: helm model-download <url>  (or use --model <existing-name>).`
      );
    }
    throw new Error(`chat: HTTP ${res.status} from Ollama. ${text.slice(0, 200)}`);
  }

  let parsed: {
    model?: string;
    message?: { role?: string; content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
    total_duration?: number;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`chat: non-JSON response from Ollama: ${text.slice(0, 200)}`);
  }

  const content = parsed.message?.content ?? "";
  return {
    model: parsed.model ?? opts.model,
    content,
    tokens: {
      promptEval: parsed.prompt_eval_count,
      eval: parsed.eval_count,
      totalMs:
        typeof parsed.total_duration === "number"
          ? Math.round(parsed.total_duration / 1_000_000)
          : undefined,
    },
  };
}

/**
 * Streaming chat. Yields one chunk per server-sent NDJSON line.
 *
 * Not used by the planner v0.1 (we want the whole JSON before validating),
 * but provided here so future surfaces (live assistant chat in the UI, etc.)
 * have a tested path.
 */
export async function* chatStream(opts: ChatOptions): AsyncGenerator<ChatStreamChunk> {
  const url = `http://127.0.0.1:${HELM_OLLAMA_PORT}/api/chat`;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    options: {
      temperature: opts.temperature ?? 0.0,
      ...(opts.numPredict !== undefined ? { num_predict: opts.numPredict } : {}),
    },
  };
  if (opts.json) body["format"] = "json";

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`chatStream: HTTP ${res.status}. ${t.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as ChatStreamChunk;
      } catch {
        // Skip non-JSON lines (Ollama mixes them sometimes).
      }
    }
  }
}
