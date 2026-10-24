/** Review card under a meal-chat reply: the user ticks what to apply. The AI never applies anything itself. */
import { useState } from "react";
import { Icon } from "@/components/icons";
import { Badge, Button, cx, useToast } from "@/components/ui";
import { api, fmtNum, fmtYen } from "@/lib/api";
import { nutrientLabel, toShown, type ChatItem, type Nutrition } from "../shared";
import type { DayRes, Entry } from "./model";

type LogOp =
  | { op: "add"; food_name: string; amount: number | null; unit: string | null; cost: number | null; nutrition: Nutrition | null; save_as_food: boolean }
  | { op: "update"; id: string; food_name: string; changes: { food_name?: string; amount?: number | null; unit?: string | null; cost?: number | null; nutrition?: Nutrition | null } }
  | { op: "remove"; id: string; food_name: string };
export type ApplyRes = DayRes & { added: number; updated: number; removed: number; targets: boolean; skipped: number; pending_ids: string[] };

const amountText = (a: number | null | undefined, u: string | null | undefined) => (a == null ? "量未設定" : `${fmtNum(a, 1)}${u ?? ""}`);
const kcalText = (n: Nutrition | null | undefined) => (n?.energy_kcal != null ? `約${fmtNum(n.energy_kcal)}kcal` : null);

export function ProposalCard({ item, entries, targets, onApplied }: { item: ChatItem; entries: Entry[]; targets: Nutrition; onApplied: (res: ApplyRes, applied: Record<string, unknown>) => void }) {
  const toast = useToast();
  const p = item.proposal as { entries?: LogOp[]; targets?: Nutrition | null; error?: string; day?: string };
  const ops = p.entries ?? [];
  const targetRows = Object.entries(p.targets ?? {}).filter(([k, v]) => targets[k] !== v);
  const [sel, setSel] = useState<Set<number>>(() => new Set(ops.map((_, i) => i)));
  const [useTargets, setUseTargets] = useState(targetRows.length > 0);
  const [busy, setBusy] = useState(false);
  const applied = item.applied;
  const count = sel.size + (useTargets ? 1 : 0);
  if (p.error) return <div className="mt-2 rounded-[var(--radius-lg)] bg-orange/10 p-3 text-sm text-label-2" data-testid="meal-proposal-error">{p.error}</div>;
  if (!ops.length && !targetRows.length) return null;

  const describe = (op: LogOp) => {
    if (op.op === "add") return { tag: "追加", tone: "green" as const, text: `${op.food_name} ${amountText(op.amount, op.unit)}`, sub: [kcalText(op.nutrition), "栄養は成分表から計算（無ければAIの推定）", op.cost != null ? fmtYen(op.cost) : null, op.save_as_food ? "よく食べるものにも登録" : null].filter(Boolean).join("・") };
    const cur = entries.find((m) => m.id === op.id);
    if (op.op === "remove") return { tag: "削除", tone: "red" as const, text: op.food_name, sub: cur ? amountText(cur.amount, cur.unit) : "" };
    const ch = op.changes; const parts: string[] = [];
    if (ch.food_name) parts.push(`名前を「${ch.food_name}」に`);
    if (ch.amount !== undefined) parts.push(`量を${amountText(cur?.amount, cur?.unit)}から${amountText(ch.amount, ch.unit ?? cur?.unit)}に`);
    if (ch.cost !== undefined) parts.push(`費用を${ch.cost == null ? "未入力" : fmtYen(ch.cost)}に`);
    if (ch.nutrition) parts.push(`栄養を${kcalText(ch.nutrition) ?? "更新"}に（推定）`);
    else if (ch.amount != null && cur?.nutrition) parts.push(cur.nutrition_source === "table" ? "栄養は成分表で計算し直し" : "栄養は量に合わせて換算（推定）");
    return { tag: "変更", tone: "accent" as const, text: op.food_name, sub: parts.join("、") };
  };
  const applyNow = async () => {
    setBusy(true);
    try {
      const r = await api.post<ApplyRes>("/health/meals/apply-proposal", { message_id: item.id, day: p.day, entries: ops.filter((_, i) => sel.has(i)), targets: useTargets ? Object.fromEntries(targetRows) : null });
      const msg = [r.added && `追加${r.added}件`, r.updated && `変更${r.updated}件`, r.removed && `削除${r.removed}件`, r.targets && "目標を更新"].filter(Boolean).join("・");
      toast(msg ? `反映しました（${msg}）` : "反映できる変更がありませんでした", msg ? "success" : "neutral");
      if (r.skipped) toast(`${r.skipped}件は今の記録と合わないため反映しませんでした`);
      onApplied(r, { added: r.added, updated: r.updated, removed: r.removed, targets: r.targets, at: new Date().toISOString() });
    } catch (e: any) { toast(e?.message ?? "反映できませんでした", "error"); } finally { setBusy(false); }
  };
  return (
    <div className="mt-2 rounded-[var(--radius-lg)] bg-subtle p-3 space-y-2 text-sm" data-testid="meal-proposal">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">反映できる変更</span>
        {applied ? <Badge tone="green"><span data-testid="meal-proposal-applied">反映済み</span></Badge> : null}
      </div>
      {ops.length > 0 && (
        <ul className="space-y-1" data-testid="meal-proposal-ops">
          {ops.map((op, i) => { const dsc = describe(op); return (
            <li key={i}>
              <label className={cx("flex items-start gap-2.5 min-h-11 py-1.5 cursor-pointer", applied && "opacity-60 cursor-default")}>
                <input type="checkbox" className="mt-0.5 accent-[var(--accent)] size-5 shrink-0" checked={sel.has(i)} disabled={!!applied || busy}
                  onChange={(e) => setSel((s0) => { const n = new Set(s0); if (e.target.checked) n.add(i); else n.delete(i); return n; })} aria-label={`${dsc.tag} ${dsc.text}`} />
                <span className="min-w-0"><Badge tone={dsc.tone} className="mr-1.5">{dsc.tag}</Badge><span>{dsc.text}</span>{dsc.sub && <span className="block text-xs text-label-2 mt-0.5">{dsc.sub}</span>}</span>
              </label>
            </li>
          ); })}
        </ul>
      )}
      {targetRows.length > 0 && (
        <div className={cx("space-y-1", applied && "opacity-60")}>
          <label className="flex items-center gap-2.5 min-h-11 cursor-pointer"><input type="checkbox" className="accent-[var(--accent)] size-5" checked={useTargets} disabled={!!applied || busy} onChange={(e) => setUseTargets(e.target.checked)} aria-label="目標値を変更する" /><Badge tone="purple">目標</Badge><span>1日の目標を変更</span></label>
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 gap-y-0.5 pl-8 text-xs tabular" data-testid="meal-proposal-targets">
            {targetRows.map(([k, v]) => { const n = nutrientLabel(k); return (
              <div key={k} className="contents"><span className="text-label-2">{n.label}</span><span className="text-right text-label-3">{targets[k] != null ? fmtNum(toShown(k, targets[k]), 1) : "未設定"}</span><Icon name="arrow-right" size={14} className="text-label-3 self-center" title="から" /><span className="text-right font-medium">{fmtNum(toShown(k, v), 1)}{n.unit}</span></div>
            ); })}
          </div>
        </div>
      )}
      {!applied && <Button size="sm" variant="primary" className="w-full" loading={busy} disabled={count === 0} onClick={applyNow} data-testid="meal-proposal-apply">選んだ変更を反映（{count}件）</Button>}
    </div>
  );
}
