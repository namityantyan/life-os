import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useNavigate } from "react-router-dom";
import type { Notification } from "@shared/types";
import { NOTIFICATION_KIND_LABELS } from "@shared/types";
import { api, useApi, fmtDateTime } from "@/lib/api";
import { Badge, Button, IconButton, Segmented, cx } from "@/components/ui";
import { Icon } from "@/components/icons";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"unread" | "all">("unread");
  const nav = useNavigate();
  const { data, reload } = useApi<{ items: Notification[]; unread: number }>(`/notifications${tab === "unread" ? "?unread=1" : ""}`, { poll: 45000, deps: [tab] });
  const unread = data?.unread ?? 0;
  const mark = async (ids: string[], unreadFlag = false) => { await api.post("/notifications/read", { ids, unread: unreadFlag }); reload(true); };
  const markAll = async () => { await api.post("/notifications/read", { all: true }); reload(true); };
  return (
    <div className="relative">
      <IconButton label="通知" onClick={() => setOpen((v) => !v)} data-testid="bell" className="relative">
        <Icon name="bell" />
        <AnimatePresence>{unread > 0 && <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} className="absolute top-0.5 right-0.5 min-w-4 h-4 px-1 rounded-full bg-red text-white text-[10px] font-bold grid place-items-center ring-2 ring-[var(--bg)]" data-testid="bell-count">{unread}</motion.span>}</AnimatePresence>
      </IconButton>
      <AnimatePresence>
        {open && (<>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <motion.div initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }} transition={{ duration: 0.14 }} className="popover absolute right-0 mt-2 w-[22rem] max-w-[calc(100vw-1.5rem)] z-40 p-3 space-y-2" data-testid="notification-panel">
            <div className="flex items-center justify-between gap-2">
              <Segmented value={tab} onChange={setTab} options={[{ value: "unread", label: "未読" }, { value: "all", label: "すべて" }]} />
              {unread > 0 && <Button size="sm" variant="ghost" onClick={markAll}>すべて既読</Button>}
            </div>
            <div className="max-h-96 overflow-auto -mx-1 px-1 space-y-1">
              {(data?.items ?? []).length === 0 && <div className="text-label-3 text-sm text-center py-6">通知はありません</div>}
              {(data?.items ?? []).map((n) => (
                <div key={n.id} className={cx("rounded-[var(--radius-md)] p-2.5 hover:bg-fill transition-colors", !n.read_at && "bg-accent-soft/40")}>
                  <div className="flex items-start gap-2">
                    <button className="focus-ring rounded-[var(--radius-sm)] flex-1 text-left min-w-0" onClick={async () => { if (!n.read_at) await mark([n.id]); setOpen(false); if (n.url) nav(n.url); }}>
                      <div className="flex items-center gap-2"><Badge tone="accent">{NOTIFICATION_KIND_LABELS[n.kind] ?? n.kind}</Badge><span className="text-xs text-label-3">{fmtDateTime(n.created_at)}</span></div>
                      <div className="font-medium text-sm mt-1 truncate">{n.title}</div>
                      {n.body && <div className="text-xs text-label-2 whitespace-pre-line line-clamp-3">{n.body}</div>}
                    </button>
                    <button className="tap focus-ring rounded-[var(--radius-sm)] px-1.5 h-7 text-xs text-label-2 hover:text-label shrink-0" onClick={() => mark([n.id], Boolean(n.read_at))}>{n.read_at ? "未読に" : "既読"}</button>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        </>)}
      </AnimatePresence>
    </div>
  );
}
