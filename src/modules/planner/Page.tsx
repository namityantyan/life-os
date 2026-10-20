import { useCallback, useMemo, useState } from "react";
import { Button, EmptyState, PageHeader, PageSkeleton, useToast } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import type { DropTarget, GoogleResponse, ListResponse, PlannerCreate, PlannerItem, PlannerPatch } from "./types";
import { addDays, fmtMD, isoAt, todayStr } from "./time";
import { WeekGrid } from "./WeekGrid";
import { SidePanel } from "./SidePanel";
import { AddModal, type AddPreset } from "./AddModal";
import { ItemModal } from "./ItemModal";

const DEFAULT_MIN = 9 * 60; // when a timed item is dropped on the all-day row

export default function Page() {
  const toast = useToast();
  const [start, setStart] = useState(todayStr);
  const end = addDays(start, 7);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);

  const list = useApi<ListResponse>(`/planner?from=${start}&to=${end}`, { poll: 60_000 });
  // Google is fetched separately so the local items never wait for the external service.
  const google = useApi<GoogleResponse>(`/planner/google?from=${start}&to=${end}`);

  const [addPreset, setAddPreset] = useState<AddPreset | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<PlannerItem | null>(null);

  const refresh = useCallback(() => list.reload(true), [list]);
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : "保存できませんでした", "error");

  const create = async (body: PlannerCreate) => {
    try { await api.post("/planner", body); await refresh(); toast("追加しました", "success"); } catch (e) { fail(e); throw e; }
  };
  const patch = async (id: string, p: PlannerPatch) => {
    try { await api.patch(`/planner/${id}`, p); await refresh(); } catch (e) { fail(e); throw e; }
  };
  const remove = async (id: string) => {
    try { await api.del(`/planner/${id}`); await refresh(); toast("削除しました"); } catch (e) { fail(e); throw e; }
  };

  const findItem = (id: string) => [...(list.data?.items ?? []), ...(list.data?.undated ?? []), ...(list.data?.done ?? [])].find((i) => i.id === id);
  const onDrop = (id: string, t: DropTarget) => {
    const it = findItem(id); if (!it) return;
    const minutes = t.minutes ?? DEFAULT_MIN;
    const p: PlannerPatch = it.type === "task" ? { date: t.date } : it.type === "event" ? { start_at: isoAt(t.date, minutes) } : { remind_at: isoAt(t.date, minutes) };
    patch(id, p).catch(() => {});
  };
  const onUnschedule = (id: string) => { const it = findItem(id); if (it && (it.date || it.start_at || it.remind_at)) patch(id, { unschedule: true }).catch(() => {}); };
  const onResize = (id: string, endIso: string) => patch(id, { end_at: endIso }).catch(() => {});
  const openAdd = (preset: AddPreset | null) => { setAddPreset(preset); setAddOpen(true); };

  if (!list.data) {
    if (list.error) return <div><PageHeader title="スケジュール" /><EmptyState title="予定を読み込めませんでした" hint={list.error} action={<Button onClick={() => list.reload()} data-testid="load-retry">再読み込み</Button>} /></div>;
    return <PageSkeleton />;
  }

  return (
    <div>
      <PageHeader title="スケジュール" subtitle={`${fmtMD(start)} – ${fmtMD(addDays(start, 6))}`}
        actions={<>
          <div className="inline-flex rounded-[var(--radius-md)] bg-fill p-0.5">
            <Button size="sm" variant="ghost" onClick={() => setStart((s) => addDays(s, -7))} aria-label="前の週" data-testid="prev-week">‹</Button>
            <Button size="sm" variant="ghost" onClick={() => setStart(todayStr())} data-testid="today">今日</Button>
            <Button size="sm" variant="ghost" onClick={() => setStart((s) => addDays(s, 7))} aria-label="次の週" data-testid="next-week">›</Button>
          </div>
          <Button variant="primary" onClick={() => openAdd(null)} data-testid="add-button">追加</Button>
        </>} />

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-2 min-w-0">
          <WeekGrid days={days} items={list.data.items} google={google.data?.items ?? []}
            onDrop={onDrop} onResize={onResize} onOpen={setSelected}
            onCellDblClick={(date, minutes) => openAdd({ date, minutes: minutes ?? undefined, type: minutes == null ? "task" : "event" })}
            onShiftDays={(n) => setStart((s) => addDays(s, n))} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-label-3">
            <span className="hidden md:inline">Shift＋スクロールで日を移動</span>
            <span className="hidden md:inline">ダブルクリックで追加</span>
            <span className="md:hidden">横にスクロールして週を確認</span>
            <span data-testid="google-status">
              {google.loading ? "Googleカレンダー: 取得中" : google.data?.connected ? (google.data.error ? "Googleカレンダー: 未取得" : `Googleカレンダー: ${google.data.items.length}件（参照用）`) : "Googleカレンダー: 未接続"}
            </span>
          </div>
        </div>
        <SidePanel undated={list.data.undated} done={list.data.done} onOpen={setSelected} onUnschedule={onUnschedule} />
      </div>

      <AddModal open={addOpen} preset={addPreset} onClose={() => setAddOpen(false)} onCreate={create} />
      <ItemModal item={selected} onClose={() => setSelected(null)} onPatch={patch} onDelete={remove} />
    </div>
  );
}
