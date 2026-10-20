import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Item, Stagger, cx } from "@/components/ui";
import type { PlannerItem } from "./types";
import { ItemCard } from "./ItemCard";
import { isPlannerDrag, readDragId } from "./dnd";

/** Undated items (drop target to unschedule) and the collapsed done-tasks group. */
export function SidePanel({ undated, done, onOpen, onUnschedule }: { undated: PlannerItem[]; done: PlannerItem[]; onOpen: (i: PlannerItem) => void; onUnschedule: (id: string) => void }) {
  const [over, setOver] = useState(false);
  const [showDone, setShowDone] = useState(false);
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="px-1 text-sm font-semibold text-label-2">日付指定なし <span className="tabular font-normal text-label-3">{undated.length}</span></h2>
        <div
          data-testid="undated-list"
          onDragOver={(e) => { if (isPlannerDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(true); } }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const id = readDragId(e); if (id) onUnschedule(id); }}
          className={cx("rounded-[var(--radius-lg)] p-2 min-h-24 transition-colors", over ? "bg-accent-soft ring-2 ring-accent/40" : "bg-subtle")}
        >
          {undated.length === 0 && <div className="text-xs text-label-3 text-center py-6">ここへドラッグすると日付指定なしに戻ります</div>}
          <Stagger className="space-y-1.5">
            <AnimatePresence initial={false}>
              {undated.map((i) => <Item key={i.id}><ItemCard item={i} onOpen={onOpen} /></Item>)}
            </AnimatePresence>
          </Stagger>
        </div>
      </section>

      <section className="space-y-2">
        <button onClick={() => setShowDone((v) => !v)} aria-expanded={showDone} data-testid="done-toggle"
          className="focus-ring flex w-full items-center justify-between px-1 text-sm font-semibold text-label-2 hover:text-label">
          <span>完了済み <span className="tabular font-normal text-label-3">{done.length}</span></span>
          <motion.span animate={{ rotate: showDone ? 90 : 0 }} className="text-label-3 text-xs">▶</motion.span>
        </button>
        <AnimatePresence initial={false}>
          {showDone && (
            <motion.div key="done" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden" data-testid="done-list">
              {done.length === 0 && <div className="text-xs text-label-3 px-1 py-2">完了したタスクはありません</div>}
              <Stagger className="space-y-1.5 p-0.5">
                {done.map((i) => <Item key={i.id}><ItemCard item={i} onOpen={onOpen} draggable={false} /></Item>)}
              </Stagger>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}
