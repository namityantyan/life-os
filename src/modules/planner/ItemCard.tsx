import { Badge, cx } from "@/components/ui";
import { TYPE_LABEL, type PlannerItem } from "./types";
import { beginDrag, endDrag } from "./dnd";
import { fmtTime, fmtMD, localDateOf } from "./time";

const DOT: Record<PlannerItem["type"], string> = { task: "bg-accent", reminder: "bg-orange", event: "bg-indigo" };

/** Draggable card for a task (all-day row) or any item in the side lists. */
export function ItemCard({ item, onOpen, compact, draggable = true }: { item: PlannerItem; onOpen: (item: PlannerItem) => void; compact?: boolean; draggable?: boolean }) {
  const when = item.type === "task" ? (item.date ? fmtMD(item.date) : null)
    : item.type === "event" ? (item.start_at ? `${fmtMD(localDateOf(item.start_at))} ${fmtTime(item.start_at)}` : null)
    : (item.remind_at ? `${fmtMD(localDateOf(item.remind_at))} ${fmtTime(item.remind_at)}` : null);
  return (
    <div
      role="button" tabIndex={0}
      draggable={draggable}
      onDragStart={(e) => beginDrag(e, item.id)}
      onDragEnd={endDrag}
      onClick={(e) => { e.stopPropagation(); onOpen(item); }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(item); }}
      data-testid={`item-${item.id}`}
      data-type={item.type}
      title={item.title}
      className={cx(
        "pressable focus-ring flex items-center gap-1.5 min-w-0 rounded-[var(--radius-sm)] bg-elevated shadow-[var(--shadow-card)] cursor-grab active:cursor-grabbing select-none",
        compact ? "px-1.5 py-0.5 text-xs" : "px-3 py-2 text-sm",
        item.done_at && "opacity-60",
      )}
    >
      {item.type === "task"
        ? <span className={cx("shrink-0 rounded-full border-[1.5px] size-3", item.done_at ? "bg-green border-green" : "border-label-3")} aria-hidden />
        : <span className={cx("shrink-0 size-2 rounded-full", DOT[item.type])} aria-hidden />}
      <span className={cx("truncate flex-1", item.done_at && "line-through text-label-2")}>{item.title}</span>
      {!compact && <span className="text-xs text-label-3 shrink-0 tabular">{when ?? <Badge>{TYPE_LABEL[item.type]}</Badge>}</span>}
    </div>
  );
}
