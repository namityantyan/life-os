import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MODULES } from "@shared/types";
import { TAB_BAR_DEFAULT, TAB_BAR_MAX, TAB_BAR_MIN } from "@shared/appearance";
import { TAB_SHORT, setTabBar, useTabBar } from "@/app/tabBar";
import { Button, IconButton, cx } from "@/components/ui";
import { Icon, ModuleIcon } from "@/components/icons";

const label = (k: string) => MODULES.find((m) => m.key === k)?.label ?? k;
const move = (list: string[], from: number, to: number) => { const n = [...list]; const [x] = n.splice(from, 1); n.splice(to, 0, x); return n; };

/** 設定 → 表示 → 下のバー: choose and order the 3–5 modules shown in the mobile bottom bar (drag the handle or use the arrows). */
export function TabBarCard() {
  const keys = useTabBar();
  const [dragging, setDragging] = useState<string | null>(null);
  const drag = useRef<{ key: string; startY: number; startIndex: number; rowH: number } | null>(null);
  const rest = MODULES.filter((m) => !keys.includes(m.key));
  const full = keys.length >= TAB_BAR_MAX, min = keys.length <= TAB_BAR_MIN;

  const onDown = (e: ReactPointerEvent<HTMLButtonElement>, key: string) => {
    const row = (e.currentTarget.closest("li") as HTMLElement | null);
    drag.current = { key, startY: e.clientY, startIndex: keys.indexOf(key), rowH: row?.offsetHeight || 52 };
    e.currentTarget.setPointerCapture(e.pointerId); setDragging(key);
  };
  const onMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current; if (!d) return;
    const to = Math.max(0, Math.min(keys.length - 1, d.startIndex + Math.round((e.clientY - d.startY) / d.rowH)));
    const from = keys.indexOf(d.key);
    if (to !== from) setTabBar(move(keys, from, to));
  };
  const onUp = () => { drag.current = null; setDragging(null); };

  return (
    <div className="space-y-4" data-testid="tabbar-settings">
      {/* Live preview of the bar */}
      <div className="rounded-[var(--radius-md)] bg-fill px-1 py-1.5 grid" style={{ gridTemplateColumns: `repeat(${keys.length + 1}, minmax(0, 1fr))` }} aria-hidden data-testid="tabbar-preview">
        {[...keys, "__more"].map((k) => (
          <div key={k} className="flex flex-col items-center gap-1 text-label-2 min-w-0">
            {k === "__more" ? <Icon name="more" size={20} /> : <ModuleIcon module={k} size={20} />}
            <span className="text-xs truncate max-w-full">{k === "__more" ? "その他" : TAB_SHORT[k] ?? label(k)}</span>
          </div>
        ))}
      </div>

      <ol className="divide-y divide-separator rounded-[var(--radius-md)] shadow-[inset_0_0_0_1px_var(--separator)]" aria-label="下のバーの並び順" data-testid="tabbar-list">
        {keys.map((k, i) => (
          <li key={k} className={cx("flex items-center gap-1 pl-1 pr-1.5 h-[52px] transition-colors", dragging === k && "bg-accent-soft")} data-testid={`tabbar-row-${k}`}>
            <button type="button" aria-label={`${label(k)}をドラッグして並び替え`} className="focus-ring size-10 grid place-items-center rounded-[var(--radius-sm)] text-label-3 cursor-grab active:cursor-grabbing touch-none"
              onPointerDown={(e) => onDown(e, k)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}><Icon name="drag" size={18} /></button>
            <ModuleIcon module={k} className="text-label-2 shrink-0" />
            <span className="flex-1 min-w-0 truncate text-sm pl-2">{label(k)}</span>
            <IconButton label={`${label(k)}を上へ`} disabled={i === 0} onClick={() => setTabBar(move(keys, i, i - 1))} data-testid={`tabbar-up-${k}`}><Icon name="chevron-up" size={18} /></IconButton>
            <IconButton label={`${label(k)}を下へ`} disabled={i === keys.length - 1} onClick={() => setTabBar(move(keys, i, i + 1))} data-testid={`tabbar-down-${k}`}><Icon name="chevron-down" size={18} /></IconButton>
            <IconButton label={`${label(k)}をバーから外す`} disabled={min} onClick={() => setTabBar(keys.filter((x) => x !== k))} data-testid={`tabbar-remove-${k}`} className="hover:text-red"><Icon name="close" size={18} /></IconButton>
          </li>
        ))}
      </ol>

      <div>
        <div className="text-xs font-medium text-label-2 mb-2">{full ? `最大${TAB_BAR_MAX}個です。追加するには1つ外してください` : "追加できるモジュール"}</div>
        <div className="flex flex-wrap gap-2">
          {rest.map((m) => (
            <button key={m.key} type="button" disabled={full} onClick={() => setTabBar([...keys, m.key])} data-testid={`tabbar-add-${m.key}`}
              className="tap pressable focus-ring inline-flex items-center gap-1.5 h-9 pl-2.5 pr-3 rounded-full bg-fill text-sm text-label-2 hover:text-label disabled:opacity-40 disabled:pointer-events-none">
              <Icon name="plus" size={16} />{m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-label-2">{TAB_BAR_MIN}〜{TAB_BAR_MAX}個。右端の「その他」からは全モジュールを開けます。</p>
        <Button variant="ghost" size="sm" onClick={() => setTabBar([...TAB_BAR_DEFAULT])} data-testid="tabbar-reset">標準の並びに戻す</Button>
      </div>
    </div>
  );
}
