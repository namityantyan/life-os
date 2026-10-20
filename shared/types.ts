// Types shared between the Worker API and the React frontend.
export type User = { id: string; email: string; name: string | null; picture: string | null };

export const NOTIFICATION_KINDS = [
  "fx", "reminder", "backup", "morning", "bedtime", "training", "weekly", "royalty", "invoice", "withholding", "system",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  fx: "FX", reminder: "リマインド", backup: "バックアップ", morning: "朝のお知らせ", bedtime: "就寝",
  training: "トレーニング", weekly: "週次まとめ", royalty: "著作権明細", invoice: "請求書・領収書",
  withholding: "源泉徴収", system: "システム",
};
export type NotificationPrefs = Record<NotificationKind, { push: boolean; discord: boolean }>;

export type Notification = {
  id: string; kind: NotificationKind; title: string; body: string | null; url: string | null;
  created_at: string; read_at: string | null;
};

export type ModuleKey =
  | "dashboard" | "planner" | "ideas" | "notes" | "health" | "training" | "assets" | "cards"
  | "fx" | "finance" | "royalty" | "backups" | "requests" | "settings";

export const MODULES: { key: ModuleKey; path: string; label: string; group: string }[] = [
  { key: "dashboard", path: "/", label: "ダッシュボード", group: "ホーム" },
  { key: "planner", path: "/planner", label: "スケジュール", group: "毎日の管理" },
  { key: "ideas", path: "/ideas", label: "アイデア", group: "毎日の管理" },
  { key: "notes", path: "/notes", label: "メモ", group: "毎日の管理" },
  { key: "health", path: "/health", label: "健康", group: "からだの管理" },
  { key: "training", path: "/training", label: "トレーニング", group: "からだの管理" },
  { key: "assets", path: "/assets", label: "資産", group: "お金・資産" },
  { key: "cards", path: "/cards", label: "カード利用", group: "お金・資産" },
  { key: "fx", path: "/fx", label: "FXシグナル", group: "お金・資産" },
  { key: "finance", path: "/finance", label: "お金", group: "お金・資産" },
  { key: "royalty", path: "/royalty", label: "明細", group: "お金・資産" },
  { key: "backups", path: "/backups", label: "バックアップ", group: "その他" },
  { key: "requests", path: "/requests", label: "リクエスト", group: "その他" },
  { key: "settings", path: "/settings", label: "設定", group: "その他" },
];

export type WeatherLocation = { name: string; lat: number; lon: number };

export type PressureLevel = "stable" | "caution" | "strong" | "unknown";
export type PressureAssessment = {
  current: number | null; delta3h: number | null; delta6h: number | null; range12h: number | null;
  level: PressureLevel; direction: "up" | "down" | "flat" | null; missing: boolean;
};

// Life Context: the shared, cross-module snapshot that AI advice is built from.
export type LifeContext = {
  now: string; // ISO JST
  user: { name: string | null };
  health: {
    oura: { day: string; sleep_duration_sec: number | null; sleep_score: number | null; readiness_score: number | null; steps: number | null; hrv: number | null; resting_hr: number | null; sleep_balance: number | null } | null;
    oura_is_today: boolean;
    pressure: PressureAssessment | null;
    checkup_latest: Record<string, unknown> | null;
    meal_summary: { energy_kcal: number | null; protein_g: number | null; fat_g: number | null; carbs_g: number | null; partial: boolean } | null;
    beauty_routine_count: number;
  };
  training: { trained_today: boolean; last_session: { part: string; started_at: string } | null; sessions_7d: number };
  planner: { tasks_open: number; events_today: { title: string; start_at: string | null }[]; reminders_pending: number };
  money: {
    card_month_total: number | null; card_budget: number | null; card_budget_left: number | null;
    personal_jpy_cash: number | null; cash_is_fresh: boolean;
  };
  fx: { open_positions: number; connector_online: boolean };
  notes: { category: string; content: string }[];
};
