import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@/lib/api";
import { Badge, Button, ChatPanel, IconButton, cx, useToast, type ChatMsg } from "@/components/ui";

type Action = { type: "task" | "reminder" | "note"; title: string; when?: string | null };
type Msg = ChatMsg & { id?: string; actions?: Action[] };
type Chip = { id: string; label: string; tone: "neutral" | "green" | "orange" | "red" | "accent" };
type Briefing = { chips: Chip[]; next_event: { title: string; start_at: string | null } | null };

const PROMPTS = ["今日は何を優先する？", "今週の振り返り", "食事と睡眠のバランスは？"];
const ACTION_LABEL: Record<Action["type"], string> = { task: "タスクにする", reminder: "リマインド", note: "メモ" };
const ACTION_DONE: Record<Action["type"], string> = { task: "タスクを追加しました", reminder: "リマインドを登録しました", note: "メモを保存しました" };

/** Global assistant: a right-side sheet on desktop, bottom sheet on mobile. ⌘J / Ctrl+J toggles. */
export function AssistantPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const toast = useToast();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); onOpenChange(!open); }
      else if (e.key === "Escape" && open) { e.preventDefault(); close(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onOpenChange, close]);

  const load = useCallback(async () => {
    try {
      const [h, b] = await Promise.all([api.get<{ items: Msg[] }>("/assistant/history"), api.get<{ briefing: Briefing }>("/assistant/briefing")]);
      setMessages(h.items); setBriefing(b.briefing);
    } catch (e: any) { toast(e?.message ?? "読み込みに失敗しました", "error"); }
    finally { setLoaded(true); }
  }, [toast]);
  const openedOnce = useRef(false);
  useEffect(() => { if (open) { openedOnce.current = true; load(); } }, [open, load]);
  // Focus the input shortly after opening.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) setTimeout(() => bodyRef.current?.querySelector<HTMLInputElement>("input[aria-label='メッセージ']")?.focus(), 60); }, [open]);

  const send = async (text: string) => {
    setBusy(true);
    setMessages((m) => [...m, { role: "user", content: text }]);
    try {
      const r = await api.post<{ assistant: Msg }>("/assistant/chat", { text });
      setMessages((m) => [...m, r.assistant]);
    } catch (e: any) { toast(e?.message ?? "送信に失敗しました", "error"); }
    finally { setBusy(false); }
  };
  const apply = async (a: Action, key: string) => {
    try {
      await api.post("/assistant/apply", { action: a });
      setApplied((s) => new Set(s).add(key));
      toast(ACTION_DONE[a.type], "success");
      window.dispatchEvent(new CustomEvent("lifeos:refresh"));
    } catch (e: any) { toast(e?.message ?? "失敗しました", "error"); }
  };
  const clear = async () => {
    await api.del("/assistant/history");
    setMessages([]); setApplied(new Set());
    toast("履歴を消しました");
  };

  // Action chips are rendered under the last assistant reply that has any.
  const lastWithActions = [...messages].reverse().find((m) => m.role === "assistant" && m.actions?.length);
  const lastIdx = lastWithActions ? messages.lastIndexOf(lastWithActions) : -1;

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[65]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={close} />
          <motion.aside role="dialog" aria-modal="true" aria-label="総合アシスタント" data-testid="assistant-panel"
            initial={{ x: "100%", y: 0 }} animate={{ x: 0, y: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", stiffness: 420, damping: 38 }}
            className="absolute right-0 top-0 h-full w-full md:w-[26rem] glass shadow-[var(--shadow-pop)] hairline md:border-l border-separator flex flex-col
                       max-md:top-auto max-md:bottom-0 max-md:h-[88dvh] max-md:rounded-t-[var(--radius-xl)]">
            <div className="flex items-center gap-2 px-4 h-14 border-b border-separator shrink-0">
              <div className="font-semibold tracking-tight">アシスタント</div>
              <kbd className="hidden md:inline text-xs text-label-3 bg-fill rounded px-1.5 py-0.5">⌘J</kbd>
              <div className="flex-1" />
              {messages.length > 0 && <Button size="sm" variant="ghost" onClick={clear} data-testid="assistant-clear">履歴を消す</Button>}
              <IconButton label="閉じる" onClick={close} data-testid="assistant-close">✕</IconButton>
            </div>
            <div className="px-4 py-3 border-b border-separator shrink-0" data-testid="assistant-briefing" aria-label="今日の要点">
              {!briefing && <div className="h-6 skeleton w-2/3" />}
              {briefing && (
                <div className="flex flex-wrap gap-1.5">
                  {briefing.chips.map((ch) => <Badge key={ch.id} tone={ch.tone} className="whitespace-nowrap">{ch.label}</Badge>)}
                  {briefing.next_event && <Badge tone="accent" className="max-w-full truncate">次: {briefing.next_event.title}</Badge>}
                </div>
              )}
            </div>
            <div ref={bodyRef} className="flex-1 min-h-0 flex flex-col px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2" data-testid="assistant-input">
              <ChatPanel
                messages={messages}
                busy={busy || (!loaded && open)}
                onSend={send}
                placeholder="今日どう動く？"
                emptyHint={loaded ? "睡眠・予定・お金・メモをまとめて見て提案します" : undefined}
                actions={(
                  <>
                    {loaded && messages.length === 0 && PROMPTS.map((p) => (
                      <button key={p} type="button" onClick={() => send(p)} data-testid="assistant-prompt" className={cx("pressable focus-ring rounded-full bg-fill px-3 h-8 text-sm text-label-2 hover:text-label")}>{p}</button>
                    ))}
                    {lastWithActions?.actions?.map((a, i) => {
                      const key = `${lastIdx}:${i}`; const done = applied.has(key);
                      return (
                        <button key={key} type="button" disabled={done} onClick={() => apply(a, key)} data-testid="assistant-action" title={a.title}
                          className={cx("pressable focus-ring rounded-full px-3 h-8 text-sm max-w-full truncate", done ? "bg-fill text-label-3" : "bg-accent-soft text-accent")}>
                          {done ? "追加済み: " : `${ACTION_LABEL[a.type]}: `}{a.title}
                        </button>
                      );
                    })}
                  </>
                )}
              />
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
