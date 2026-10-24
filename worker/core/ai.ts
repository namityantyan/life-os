import type { Env } from "../env";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Workers AI wrapper. Returns { text, provider }. If the AI binding is unavailable
 * (local dev without login, or quota issues) a deterministic fallback is returned so the
 * UI and tests keep working; the caller can show `provider: "fallback"` to the user.
 */
export async function chat(env: Env, messages: ChatMessage[], opts: { maxTokens?: number; json?: boolean; timeoutMs?: number } = {}): Promise<{ text: string; provider: "workers-ai" | "fallback" }> {
  try {
    if (!env.AI) throw new Error("AI binding missing");
    const call = env.AI.run(MODEL as any, {
      messages,
      // JSON replies carry structure (and the whole routine), so they need more room than prose.
      max_tokens: opts.maxTokens ?? (opts.json ? 2000 : 800),
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    } as any, ...(opts.timeoutMs ? [{ timeoutMs: opts.timeoutMs, retry: false } as any] : []));
    // `timeoutMs` is a hard bound for quick, optional calls: the relay shim aborts its fetch (no retry),
    // and the race covers the Workers binding, which has no timeout of its own.
    const res = (await (opts.timeoutMs ? Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error(`AI timeout ${opts.timeoutMs}ms`)), opts.timeoutMs))]) : call)) as { response?: string | object; choices?: { message?: { content?: string }; finish_reason?: string }[] };
    // Workers AI returns { response: string } for prose, but with response_format it can be an already
    // parsed object, and some models answer OpenAI-style in { choices }.
    const raw = res?.response ?? res?.choices?.[0]?.message?.content ?? "";
    const text = (typeof raw === "string" ? raw : JSON.stringify(raw)).trim();
    if (!text) throw new Error("empty response");
    if (res?.choices?.[0]?.finish_reason === "length") console.warn("ai: reply hit the token limit");
    return { text, provider: "workers-ai" };
  } catch (e) {
    console.warn("ai failed", String(e));
    return { text: fallbackReply(messages, opts.json), provider: "fallback" };
  }
}

function fallbackReply(messages: ChatMessage[], json?: boolean): string {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (json) return JSON.stringify({ title: last.slice(0, 40), markdown: `# ${last.slice(0, 40)}\n\n${last}`, note: "AI未接続のため原文をそのまま整形しました" });
  return `（AIに接続できないため、保存済みデータだけで応答しています）\n\n受け取った内容: ${last.slice(0, 200)}`;
}

export async function chatJson<T>(env: Env, messages: ChatMessage[], fallback: T, opts: { timeoutMs?: number; maxTokens?: number } = {}): Promise<{ data: T; provider: "workers-ai" | "fallback"; parsed: boolean }> {
  const r = await chat(env, messages, { json: true, ...opts });
  if (r.provider === "fallback") return { data: fallback, provider: "fallback", parsed: false };
  const parsedOut = parseJsonLoose<T>(r.text);
  if (parsedOut === undefined) {
    console.warn("ai: could not parse JSON reply", r.text.slice(0, 200));
    return { data: fallback, provider: r.provider, parsed: false };
  }
  return { data: parsedOut, provider: r.provider, parsed: true };
}

/**
 * Parses a model's JSON answer. Handles ```json fences and a reply cut off by the token limit
 * (closing the still-open brackets, dropping a trailing partial value). Returns undefined on failure.
 */
export function parseJsonLoose<T>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  if (start < 0) return undefined;
  const candidate = body.slice(start);
  try { return JSON.parse(candidate.slice(0, candidate.lastIndexOf("}") + 1)) as T; } catch { /* try repairing */ }
  // Walk the text, tracking the bracket stack, then close whatever is still open.
  const stack: string[] = []; let inStr = false, esc = false, lastSafe = -1;
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i]!;
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," && stack.length) lastSafe = i; // last complete element boundary
  }
  if (!stack.length) return undefined;
  for (const cut of [candidate.length, lastSafe]) {
    if (cut < 0) continue;
    let head = candidate.slice(0, cut).replace(/,\s*$/, "");
    const open: string[] = []; let s2 = false, e2 = false;
    for (let i = 0; i < head.length; i++) {
      const c = head[i]!;
      if (e2) { e2 = false; continue; }
      if (c === "\\") { e2 = true; continue; }
      if (c === '"') { s2 = !s2; continue; }
      if (s2) continue;
      if (c === "{" || c === "[") open.push(c === "{" ? "}" : "]");
      else if (c === "}" || c === "]") open.pop();
    }
    if (s2) head += '"';
    head = head.replace(/[,:]\s*$/, "");
    try { return JSON.parse(head + open.reverse().join("")) as T; } catch { /* next */ }
  }
  return undefined;
}
