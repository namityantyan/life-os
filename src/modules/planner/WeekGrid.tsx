import { useEffect, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cx } from "@/components/ui";
import type { DropTarget, GoogleEvent, PlannerItem } from "./types";
import { ItemCard } from "./ItemCard";
import { beginDrag, endDrag, isPlannerDrag, readDragId } from "./dnd";
import { dayTone, durationMin, fmtMD, fmtTime, isoAt, localDateOf, minutesOfDay, snap15, todayStr, weekdayJa } from "./time";

export const HOUR_PX = 56;
const DAY_PX = HOUR_PX * 24;
const MIN_EVENT = 15;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

type Props = {
  days: string[];
  items: PlannerItem[];
  google: GoogleEvent[];
  onDrop: (id: string, target: DropTarget) => void;
  onResize: (id: string, endIso: string) => void;
  onOpen: (item: PlannerItem) => void;
  onCellDblClick: (date: string, minutes: number | null) => void;
  onShiftDays: (n: number) => void;
};

const toneCls = (t: "blue" | "red" | null) => (t === "blue" ? "text-accent" : t === "red" ? "text-red" : "text-label");

export function WeekGrid({ days, items, google, onDrop, onResize, onOpen, onCellDblClick, onShiftDays }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wheelAcc = useRef(0);
  const [overCell, setOverCell] = useState<string | null>(null);
  const [resize, setResize] = useState<{ id: string; date: string; startMin: number; endMin: number } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const today = todayStr();

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_PX - 12; }, []);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);

  // Shift + wheel scrolls the displayed days horizontally.
  const onWheel = (e: React.WheelEvent) => {
    if (!e.shiftKey) return;
    wheelAcc.current += e.deltaX || e.deltaY;
    if (Math.abs(wheelAcc.current) >= 60) { onShiftDays(wheelAcc.current > 0 ? 1 : -1); wheelAcc.current = 0; }
  };

  // ---- drop helpers ----
  const allow = (e: DragEvent, key: string) => { if (isPlannerDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOverCell(key); } };
  const dropAllDay = (e: DragEvent, date: string) => { e.preventDefault(); setOverCell(null); const id = readDragId(e); if (id) onDrop(id, { date, minutes: null }); };
  const dropColumn = (e: DragEvent, date: string) => {
    e.preventDefault(); setOverCell(null);
    const id = readDragId(e); if (!id) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = Math.max(0, Math.min(DAY_PX, e.clientY - rect.top)) / HOUR_PX * 60;
    onDrop(id, { date, minutes: snap15(minutes) });
  };
  const dblColumn = (e: React.MouseEvent, date: string) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const hour = Math.max(0, Math.min(23, Math.floor((e.clientY - rect.top) / HOUR_PX)));
    onCellDblClick(date, hour * 60);
  };

  // ---- resize (bottom edge, 15-min steps) ----
  const startResize = (e: RPointerEvent, item: PlannerItem, date: string, startMin: number, endMin: number) => {
    e.preventDefault(); e.stopPropagation();
    const originY = e.clientY;
    const origEnd = endMin;
    setResize({ id: item.id, date, startMin, endMin });
    const move = (ev: PointerEvent) => {
      const next = Math.max(startMin + MIN_EVENT, snap15(origEnd + (ev.clientY - originY) / HOUR_PX * 60));
      setResize((r) => (r && r.id === item.id ? { ...r, endMin: next } : r));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      const next = Math.max(startMin + MIN_EVENT, snap15(origEnd + (ev.clientY - originY) / HOUR_PX * 60));
      setResize(null);
      if (next !== origEnd) onResize(item.id, isoAt(date, next));
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  const tasksOf = (date: string) => items.filter((i) => i.type === "task" && i.date === date);
  const timedOf = (date: string) => items.filter((i) => (i.type === "event" && i.start_at && localDateOf(i.start_at) === date) || (i.type === "reminder" && i.remind_at && localDateOf(i.remind_at) === date));
  const googleAllDay = (date: string) => google.filter((g) => g.all_day && localDateOf(g.start_at) <= date && date < localDateOf(g.end_at));
  const googleTimed = (date: string) => google.filter((g) => !g.all_day && localDateOf(g.start_at) === date);
  const openGoogle = (g: GoogleEvent) => { if (g.html_link) window.open(g.html_link, "_blank", "noopener,noreferrer"); };

  const cols = "grid grid-cols-[3.25rem_repeat(7,minmax(0,1fr))]";

  return (
    <div className="card overflow-x-auto overflow-y-hidden select-none" data-testid="week-grid" onWheel={onWheel}>
      <div className="min-w-[40rem]">
      {/* day headers */}
      <div className={cx(cols, "border-b border-separator")}>
        <div />
        {days.map((d) => {
          const isToday = d === today;
          return (
            <div key={d} className={cx("py-2 text-center border-l border-separator", toneCls(dayTone(d)))} data-testid={`day-header-${d}`}>
              <div className="text-xs font-medium opacity-80">{weekdayJa(d)}</div>
              <div className={cx("mx-auto mt-0.5 grid size-7 place-items-center rounded-full text-sm font-semibold tabular", isToday && "bg-accent text-white")}>{fmtMD(d).split("/")[1]}</div>
              <div className="text-xs opacity-60 tabular">{fmtMD(d).split("/")[0]}月</div>
            </div>
          );
        })}
      </div>

      {/* all-day row (tasks) */}
      <div className={cx(cols, "border-b border-separator bg-subtle/60")}>
        <div className="text-xs text-label-3 text-right pr-1.5 pt-1.5">終日</div>
        {days.map((d) => (
          <div key={d} data-testid={`allday-cell-${d}`}
            onDragOver={(e) => allow(e, `a:${d}`)} onDragLeave={() => setOverCell(null)} onDrop={(e) => dropAllDay(e, d)}
            onDoubleClick={() => onCellDblClick(d, null)}
            className={cx("min-h-11 p-1 space-y-1 border-l border-separator transition-colors", overCell === `a:${d}` && "bg-accent-soft")}>
            <AnimatePresence initial={false}>
              {tasksOf(d).map((t) => (
                <motion.div key={t.id} layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <ItemCard item={t} onOpen={onOpen} compact />
                </motion.div>
              ))}
            </AnimatePresence>
            {googleAllDay(d).map((g) => (
              <div key={g.id} data-testid={`gcal-${g.id}`} title={g.title} onDoubleClick={(e) => { e.stopPropagation(); openGoogle(g); }}
                className="truncate rounded-[var(--radius-sm)] border border-dashed border-label-3 px-1.5 py-0.5 text-xs text-label-2 cursor-default">{g.title}</div>
            ))}
          </div>
        ))}
      </div>

      {/* hourly grid */}
      <div ref={scrollRef} className="max-h-[58vh] overflow-y-auto overscroll-contain">
        <div className={cx(cols, "relative")} style={{ height: DAY_PX }}>
          <div className="relative">
            {HOURS.map((h) => <div key={h} className="absolute right-1.5 -translate-y-1/2 text-xs text-label-3 tabular" style={{ top: h * HOUR_PX }}>{h === 0 ? "" : `${h}:00`}</div>)}
          </div>
          {days.map((d) => {
            const isToday = d === today;
            const nowMin = now.getHours() * 60 + now.getMinutes();
            return (
              <div key={d} className={cx("relative border-l border-separator", overCell === `c:${d}` && "bg-accent-soft/40")}
                onDragOver={(e) => allow(e, `c:${d}`)} onDragLeave={() => setOverCell(null)} onDrop={(e) => dropColumn(e, d)}
                onDoubleClick={(e) => dblColumn(e, d)}>
                {HOURS.map((h) => <div key={h} data-testid={`hour-cell-${d}-${h}`} className="border-t border-separator/70" style={{ height: HOUR_PX }} />)}
                {isToday && <div className="absolute left-0 right-0 z-20 h-px bg-red pointer-events-none" style={{ top: nowMin / 60 * HOUR_PX }} data-testid="now-line"><span className="absolute -left-1 -top-1 size-2 rounded-full bg-red" /></div>}

                {googleTimed(d).map((g) => {
                  const s = minutesOfDay(g.start_at); const dur = Math.max(MIN_EVENT, Math.min(durationMin(g.start_at, g.end_at), 1440 - s));
                  return (
                    <div key={g.id} data-testid={`gcal-${g.id}`} title={`${g.title}（Googleカレンダー）`} onDoubleClick={(e) => { e.stopPropagation(); openGoogle(g); }}
                      className="absolute left-2 right-0.5 z-[5] overflow-hidden rounded-[var(--radius-sm)] border border-dashed border-label-3 bg-elevated/70 px-1.5 py-0.5 text-xs text-label-2 cursor-default"
                      style={{ top: s / 60 * HOUR_PX, height: dur / 60 * HOUR_PX - 2 }}>
                      <div className="truncate font-medium">{g.title}</div>
                      <div className="text-xs opacity-70 tabular">{fmtTime(g.start_at)}–{fmtTime(g.end_at)}</div>
                    </div>
                  );
                })}

                {timedOf(d).map((it) => {
                  if (it.type === "reminder") {
                    const m = minutesOfDay(it.remind_at!);
                    return (
                      <div key={it.id} data-testid={`item-${it.id}`} data-type="reminder" role="button" tabIndex={0} title={it.title}
                        draggable onDragStart={(e) => beginDrag(e, it.id)} onDragEnd={endDrag}
                        onClick={(e) => { e.stopPropagation(); onOpen(it); }} onDoubleClick={(e) => e.stopPropagation()}
                        className="pressable focus-ring absolute left-0.5 right-2 z-10 flex items-center gap-1 rounded-full bg-orange/15 px-1.5 text-xs text-orange cursor-grab active:cursor-grabbing"
                        style={{ top: m / 60 * HOUR_PX - 10, height: 20 }}>
                        <span className="shrink-0 size-1.5 rounded-full bg-orange" /><span className="truncate">{it.title}</span><span className="ml-auto shrink-0 tabular opacity-70">{fmtTime(it.remind_at!)}</span>
                      </div>
                    );
                  }
                  const s = minutesOfDay(it.start_at!);
                  const live = resize?.id === it.id ? resize.endMin : s + durationMin(it.start_at!, it.end_at ?? it.start_at!);
                  const e = Math.max(s + MIN_EVENT, live);
                  const h = Math.min(e, 1440) - s;
                  return (
                    <div key={it.id} data-testid={`item-${it.id}`} data-type="event" role="button" tabIndex={0} title={it.title}
                      draggable={!resize} onDragStart={(ev) => beginDrag(ev, it.id)} onDragEnd={endDrag}
                      onClick={(ev) => { ev.stopPropagation(); onOpen(it); }} onDoubleClick={(ev) => ev.stopPropagation()}
                      className={cx("pressable focus-ring absolute left-0.5 right-2 z-10 overflow-hidden rounded-[var(--radius-sm)] border-l-2 border-accent bg-accent-soft px-1.5 py-0.5 text-xs text-accent cursor-grab active:cursor-grabbing", resize?.id === it.id && "ring-2 ring-accent/40")}
                      style={{ top: s / 60 * HOUR_PX, height: h / 60 * HOUR_PX - 2 }}>
                      <div className="truncate font-medium">{it.title}</div>
                      <div className="text-xs opacity-80 tabular">{fmtTime(it.start_at!)}–{fmtTime(isoAt(d, e))}</div>
                      <div data-testid={`resize-${it.id}`} role="separator" aria-orientation="horizontal" aria-label="終了時刻を変更" onPointerDown={(ev) => startResize(ev, it, d, s, s + durationMin(it.start_at!, it.end_at ?? it.start_at!))} onDragStart={(ev) => { ev.preventDefault(); ev.stopPropagation(); }} draggable={false}
                        className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize hover:bg-accent/20" />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      </div>
    </div>
  );
}
