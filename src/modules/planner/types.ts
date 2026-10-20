// Mirrors worker/modules/planner/logic.ts (the frontend tsconfig cannot import from worker/).
export type PlannerType = "task" | "reminder" | "event";
export const TYPE_LABEL: Record<PlannerType, string> = { task: "タスク", reminder: "リマインド", event: "予定" };

export type PlannerItem = {
  id: string;
  type: PlannerType;
  title: string;
  notes: string | null;
  date: string | null;
  start_at: string | null;
  end_at: string | null;
  remind_at: string | null;
  reminded_at: string | null;
  done_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GoogleEvent = { id: string; title: string; start_at: string; end_at: string; all_day: boolean; html_link: string | null };

export type ListResponse = { from: string; to: string; items: PlannerItem[]; undated: PlannerItem[]; done: PlannerItem[] };
export type GoogleResponse = { connected: boolean; items: GoogleEvent[]; error?: string };

export type PlannerPatch = {
  title?: string; notes?: string | null; date?: string | null; start_at?: string | null; end_at?: string | null; remind_at?: string | null;
  done?: boolean; unschedule?: boolean;
};
export type PlannerCreate = { type: PlannerType; title: string; notes?: string | null; date?: string | null; start_at?: string | null; end_at?: string | null; remind_at?: string | null };

/** Where a dragged card was dropped. minutes = null means the all-day row. */
export type DropTarget = { date: string; minutes: number | null };
