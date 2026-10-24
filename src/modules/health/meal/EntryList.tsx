/** The day's items. Tapping a row opens its edit sheet; nutrition state is always visible on the row. */
import { motion, AnimatePresence } from "motion/react";
import { Icon } from "@/components/icons";
import { Badge, Card, Spinner, cx, quick } from "@/components/ui";
import { fmtNum, fmtYen } from "@/lib/api";
import { MACROS, SOURCE, amountText, isTemp, type Entry } from "./model";
import type { LookupState } from "./store";

export function EntryList({ entries, lookups, onOpen, onDelete, empty, keyOf = (id) => id }: {
  keyOf?: (id: string) => string; entries: Entry[]; lookups: Record<string, LookupState>; onOpen: (e: Entry) => void; onDelete: (e: Entry) => void; empty: React.ReactNode;
}) {
  if (!entries.length) return <Card>{empty}</Card>;
  return (
    <Card padded={false} className="overflow-hidden">
      <ul className="divide-y divide-separator" data-testid="meal-list">
        <AnimatePresence initial={false}>
          {entries.map((e) => {
            const lk = lookups[e.id]; const temp = isTemp(e.id); const busy = temp || lk?.busy;
            const n = e.nutrition; const src = e.nutrition_source ? SOURCE[e.nutrition_source] : null;
            return (
              <motion.li key={keyOf(e.id)} layout="position" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={quick} className="group relative">
                <button type="button" onClick={() => !temp && onOpen(e)} disabled={temp} data-testid="meal-item" aria-label={`${e.food_name}を編集`}
                  className="focus-ring w-full text-left flex items-center gap-3 px-5 py-3 min-h-[3.75rem] hover:bg-fill/60 disabled:cursor-progress">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="font-medium truncate">{e.food_name}</span>
                      <span className="text-sm text-label-2 tabular shrink-0">{e.amount != null ? amountText(e.amount, e.unit) : ""}{e.servings !== 1 ? ` ×${fmtNum(e.servings, 1)}` : ""}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-label-3 tabular min-w-0">
                      {busy && !n ? <span className="flex items-center gap-1.5 text-label-2"><Spinner className="size-3" />成分表で計算中</span>
                        : n ? <>
                            {src && <Badge tone={src.tone}>{src.label}</Badge>}
                            <span className="truncate">{MACROS.map((m) => `${m.short} ${fmtNum(n[m.key], 1)}`).join("  ")}{e.cost != null ? `  ${fmtYen(e.cost)}` : ""}</span>
                            {busy && <Spinner className="size-3" />}
                          </>
                        : <span className="text-orange truncate">{lk?.note?.includes("ありません") ? "成分表に無い食品・タップして値を入力" : "未計算・タップして成分表から選ぶ"}</span>}
                    </div>
                    {e.nutrition_ref && e.nutrition_source === "table" && <div className="text-[0.6875rem] text-label-3 truncate mt-0.5" data-testid="entry-ref">{e.nutrition_ref.name} {fmtNum(e.nutrition_ref.grams)}g{e.nutrition_ref.grams_estimated ? "（量はAIの見積もり）" : ""}{e.servings !== 1 ? ` ×${fmtNum(e.servings, 1)}` : ""}</div>}
                  </div>
                  <div className={cx("text-right shrink-0 tabular", !n && "text-label-3")}>
                    <span className="text-lg font-semibold">{n?.energy_kcal != null ? fmtNum(n.energy_kcal) : "—"}</span><span className="text-xs text-label-3 ml-0.5">kcal</span>
                  </div>
                  {!temp && <Icon name="chevron-right" size={16} className="text-label-3 shrink-0 [@media(pointer:fine)]:group-hover:opacity-0" />}
                </button>
                {!temp && (
                  <button type="button" onClick={() => onDelete(e)} aria-label={`${e.food_name}を削除`}
                    className="hidden [@media(pointer:fine)]:grid absolute right-3 top-1/2 -translate-y-1/2 size-8 place-items-center rounded-full text-label-3 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-red hover:bg-fill transition-opacity">
                    <Icon name="delete" size={16} />
                  </button>
                )}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </Card>
  );
}
