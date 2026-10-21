import type { Env } from "../env";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Workers AI wrapper. Returns { text, provider }. If the AI binding is unavailable
 * (local dev without login, or quota issues) a deterministic fallback is returned so the
 * UI and tests keep working; the caller can show `provider: "fallback"` to the user.
 */
export async function chat(env: Env, messages: ChatMessage[], opts: { maxTokens?: number; json?: boolean } = {}): Promise<{ text: string; provider: "workers-ai" | "fallback" }> {
  try {
    if (!env.AI) throw new Error("AI binding missing");
    const res = (await env.AI.run(MODEL as any, {
      messages,
      max_tokens: opts.maxTokens ?? 800,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    } as any)) as { response?: string | object; choices?: { message?: { content?: string } }[] };
    // Workers AI returns { response } for most models, but OpenAI-style { choices } for some (e.g. Llama 3.3 fast).
    const raw = res?.response ?? res?.choices?.[0]?.message?.content ?? "";
    const text = (typeof raw === "string" ? raw : JSON.stringify(raw)).trim();
    if (!text) throw new Error("empty response");
    return { text, provider: "workers-ai" };
  } catch (e) {
    return { text: fallbackReply(messages, opts.json), provider: "fallback" };
  }
}

function fallbackReply(messages: ChatMessage[], json?: boolean): string {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (json) return JSON.stringify({ title: last.slice(0, 40), markdown: `# ${last.slice(0, 40)}\n\n${last}`, note: "AI未接続のため原文をそのまま整形しました" });
  return `（AIに接続できないため、保存済みデータだけで応答しています）\n\n受け取った内容: ${last.slice(0, 200)}`;
}

export async function chatJson<T>(env: Env, messages: ChatMessage[], fallback: T): Promise<{ data: T; provider: "workers-ai" | "fallback" }> {
  const r = await chat(env, messages, { json: true });
  try {
    const start = r.text.indexOf("{");
    const end = r.text.lastIndexOf("}");
    const data = JSON.parse(r.text.slice(start, end + 1)) as T;
    return { data, provider: r.provider };
  } catch {
    return { data: fallback, provider: "fallback" };
  }
}
