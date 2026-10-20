// Exercise catalog shared by the Worker API and the React frontend.
// Derived from the previous app's workout/exercise_catalog.json (96 strength exercises + bouldering).
// Naming / part / equipment organisation referenced NSCA Japan and the ACE Exercise Library.

export const PARTS = ["胸", "背中", "肩", "腕", "脚", "尻", "腹", "その他"] as const;
export type Part = (typeof PARTS)[number];

export const EQUIPMENTS = ["barbell", "dumbbell", "machine", "cable", "smith", "bodyweight"] as const;
export type Equipment = (typeof EQUIPMENTS)[number];
export const EQUIPMENT_LABELS: Record<Equipment, string> = {
  barbell: "バーベル", dumbbell: "ダンベル", machine: "マシン", cable: "ケーブル", smith: "スミス", bodyweight: "自重",
};

/** How the weight of a set is recorded. */
export type WeightUnit = "total" | "per_hand" | "plate" | "bodyweight" | "time";
export const UNIT_LABELS: Record<WeightUnit, string> = {
  total: "合計重量", per_hand: "片手重量", plate: "プレート重量", bodyweight: "自重", time: "保持時間",
};
export type Measurement = "reps" | "seconds";

export type CatalogEntry = {
  key: string;
  name: string;
  english_name: string;
  part: Part;
  secondary_parts: Part[];
  equipment: Equipment;
  unit: "total" | "per_hand" | "plate" | "bodyweight";
  measurement: Measurement;
  aliases: string[];
  rep_min: number;
  rep_max: number;
  increment: number;
};

export const CATALOG: readonly CatalogEntry[] = [
  { key: "bench_press", name: "ベンチプレス", english_name: "Barbell Bench Press", part: "胸", secondary_parts: ["肩", "腕"], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["バーベルベンチプレス", "bench press"], rep_min: 6, rep_max: 12, increment: 2.5 },
  { key: "incline_db_press", name: "インクラインダンベルプレス", english_name: "Incline Dumbbell Press", part: "胸", secondary_parts: ["肩", "腕"], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["インクラインDBプレス", "incline dumbbell press", "インクラインプレス"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "pec_fly", name: "ペックフライ（マシン）", english_name: "Machine Pec Fly", part: "胸", secondary_parts: [], equipment: "machine", unit: "total", measurement: "reps", aliases: ["ペックフライ", "pec fly", "machine chest fly", "ペックデック"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "chest_press", name: "チェストプレス（マシン）", english_name: "Machine Chest Press", part: "胸", secondary_parts: ["肩", "腕"], equipment: "machine", unit: "total", measurement: "reps", aliases: ["チェストプレス", "machine chest press"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "incline_barbell_press", name: "インクラインベンチプレス", english_name: "Barbell Incline Bench Press", part: "胸", secondary_parts: ["肩", "腕"], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["インクラインバーベルプレス", "incline bench press"], rep_min: 6, rep_max: 12, increment: 2.5 },
  { key: "decline_barbell_press", name: "デクラインベンチプレス", english_name: "Barbell Decline Bench Press", part: "胸", secondary_parts: ["腕"], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["デクラインプレス", "decline bench press"], rep_min: 6, rep_max: 12, increment: 2.5 },
  { key: "flat_db_press", name: "ダンベルベンチプレス", english_name: "Dumbbell Bench Press", part: "胸", secondary_parts: ["肩", "腕"], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["フラットダンベルプレス", "dumbbell bench press"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "decline_db_press", name: "デクラインダンベルプレス", english_name: "Decline Dumbbell Press", part: "胸", secondary_parts: ["腕"], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["decline dumbbell press"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "cable_crossover", name: "ケーブルクロスオーバー", english_name: "Cable Crossover", part: "胸", secondary_parts: [], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ケーブルクロス", "cable cross-over"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "low_cable_fly", name: "ローケーブルフライ", english_name: "Low Cable Fly", part: "胸", secondary_parts: ["肩"], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ローケーブルクロスオーバー", "low cable crossover"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "high_cable_fly", name: "ハイケーブルフライ", english_name: "High Cable Fly", part: "胸", secondary_parts: [], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ハイケーブルクロスオーバー", "high cable crossover"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "smith_bench_press", name: "ベンチプレス（スミス）", english_name: "Smith Machine Bench Press", part: "胸", secondary_parts: ["肩", "腕"], equipment: "smith", unit: "plate", measurement: "reps", aliases: ["スミスベンチプレス", "smith bench press"], rep_min: 6, rep_max: 12, increment: 2.5 },
  { key: "smith_incline_press", name: "インクラインベンチプレス（スミス）", english_name: "Smith Machine Incline Press", part: "胸", secondary_parts: ["肩", "腕"], equipment: "smith", unit: "plate", measurement: "reps", aliases: ["スミスインクラインプレス", "smith incline press"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "push_up", name: "プッシュアップ", english_name: "Push-Up", part: "胸", secondary_parts: ["肩", "腕"], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["腕立て伏せ", "push up", "press-up"], rep_min: 8, rep_max: 20, increment: 1 },
  { key: "dips", name: "ディップス", english_name: "Chest Dip", part: "胸", secondary_parts: ["肩", "腕"], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["チェストディップ", "chest dip", "chest dips"], rep_min: 6, rep_max: 15, increment: 1 },
  { key: "lat_pulldown", name: "ラットプルダウン（マシン）", english_name: "Machine Lat Pulldown", part: "背中", secondary_parts: ["腕"], equipment: "machine", unit: "total", measurement: "reps", aliases: ["ラットプルダウン", "lat pulldown", "lat pull-down"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "seated_row", name: "シーテッドロウ（マシン）", english_name: "Machine Seated Row", part: "背中", secondary_parts: ["腕"], equipment: "machine", unit: "total", measurement: "reps", aliases: ["シーテッドロー", "seated row", "seated cable row (machine)", "シーテッドロウ"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "deadlift", name: "デッドリフト", english_name: "Barbell Deadlift", part: "背中", secondary_parts: ["脚", "尻"], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["バーベルデッドリフト", "conventional deadlift"], rep_min: 5, rep_max: 10, increment: 2.5 },
  { key: "bent_over_row", name: "ベントオーバーロウ", english_name: "Barbell Bent-Over Row", part: "背中", secondary_parts: ["腕"], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["バーベルベントオーバーロー", "bent over row"], rep_min: 6, rep_max: 12, increment: 2.5 },
  { key: "one_arm_db_row", name: "ワンハンドダンベルロウ", english_name: "Single-Arm Dumbbell Row", part: "背中", secondary_parts: ["腕"], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["ワンハンドロー", "single arm dumbbell row"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "chest_supported_row", name: "チェストサポートロウ", english_name: "Chest-Supported Dumbbell Row", part: "背中", secondary_parts: ["腕"], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["インクラインベンチダンベルロウ", "chest supported row"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "t_bar_row", name: "Tバーロウ", english_name: "T-Bar Row", part: "背中", secondary_parts: ["腕"], equipment: "machine", unit: "total", measurement: "reps", aliases: ["ティーバーロー", "t-bar row"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "wide_grip_pulldown", name: "ワイドグリップラットプルダウン", english_name: "Wide-Grip Lat Pulldown", part: "背中", secondary_parts: ["腕"], equipment: "machine", unit: "total", measurement: "reps", aliases: ["ワイドラットプルダウン", "wide grip pulldown"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "close_grip_pulldown", name: "ナローグリップラットプルダウン", english_name: "Close-Grip Lat Pulldown", part: "背中", secondary_parts: ["腕"], equipment: "machine", unit: "total", measurement: "reps", aliases: ["ナローラットプルダウン", "close grip pulldown"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "straight_arm_pulldown", name: "ストレートアームプルダウン", english_name: "Straight-Arm Pulldown", part: "背中", secondary_parts: [], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ケーブルプルオーバー", "straight arm cable pulldown"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "face_pull", name: "フェイスプル", english_name: "Cable Face Pull", part: "背中", secondary_parts: ["肩"], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ケーブルフェイスプル", "face pull"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "back_extension", name: "バックエクステンション", english_name: "Back Extension", part: "背中", secondary_parts: ["尻"], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["ハイパーエクステンション", "hyperextension"], rep_min: 10, rep_max: 15, increment: 1 },
  { key: "pull_up", name: "懸垂", english_name: "Pull-Up", part: "背中", secondary_parts: ["腕"], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["チンニング", "pull up", "pull-up"], rep_min: 5, rep_max: 12, increment: 1 },
  { key: "chin_up", name: "チンアップ", english_name: "Chin-Up", part: "背中", secondary_parts: ["腕"], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["逆手懸垂", "chin up", "chin-up"], rep_min: 5, rep_max: 12, increment: 1 },
  { key: "barbell_shrug", name: "バーベルシュラッグ", english_name: "Barbell Shrug", part: "背中", secondary_parts: ["肩"], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["シュラッグ（バーベル）", "barbell shrugs"], rep_min: 8, rep_max: 15, increment: 2.5 },
  { key: "db_shrug", name: "ダンベルシュラッグ", english_name: "Dumbbell Shrug", part: "背中", secondary_parts: ["肩"], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["シュラッグ（ダンベル）", "dumbbell shrugs"], rep_min: 8, rep_max: 15, increment: 1 },
  { key: "db_shoulder_press", name: "ダンベルショルダープレス", english_name: "Dumbbell Shoulder Press", part: "肩", secondary_parts: ["腕"], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["ショルダープレス（ダンベル）", "dumbbell shoulder press", "DBショルダープレス（片手）", "DBショルダープレス"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "side_raise", name: "ダンベルサイドレイズ", english_name: "Dumbbell Lateral Raise", part: "肩", secondary_parts: [], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["サイドレイズ", "side raise", "lateral raise"], rep_min: 10, rep_max: 15, increment: 1 },
  { key: "rear_delt_fly", name: "ダンベルリアデルトフライ", english_name: "Dumbbell Rear-Delt Fly", part: "肩", secondary_parts: ["背中"], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["リアレイズ", "rear delt fly", "bent-over reverse fly", "リアデルトフライ"], rep_min: 10, rep_max: 15, increment: 1 },
  { key: "cable_side_raise", name: "ケーブルサイドレイズ", english_name: "Cable Lateral Raise", part: "肩", secondary_parts: [], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ケーブルサイドレイズ", "cable side raise"], rep_min: 10, rep_max: 15, increment: 1 },
  { key: "cable_shoulder_press", name: "ケーブルショルダープレス", english_name: "Cable Shoulder Press", part: "肩", secondary_parts: ["腕"], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ケーブルショルダープレス", "cable shoulder press"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "cable_rear_delt_fly", name: "ケーブルリアデルトフライ", english_name: "Cable Rear-Delt Fly", part: "肩", secondary_parts: ["背中"], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ケーブルリアレイズ", "cable rear delt fly"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "overhead_press", name: "オーバーヘッドプレス", english_name: "Barbell Overhead Press", part: "肩", secondary_parts: ["腕"], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["ミリタリープレス", "overhead press", "barbell shoulder press"], rep_min: 6, rep_max: 12, increment: 2.5 },
  { key: "machine_shoulder_press", name: "ショルダープレス（マシン）", english_name: "Machine Shoulder Press", part: "肩", secondary_parts: ["腕"], equipment: "machine", unit: "total", measurement: "reps", aliases: ["マシンショルダープレス", "machine shoulder press", "ショルダープレス（マシン・方式未指定）"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "smith_shoulder_press", name: "ショルダープレス（スミス）", english_name: "Smith Machine Shoulder Press", part: "肩", secondary_parts: ["腕"], equipment: "smith", unit: "plate", measurement: "reps", aliases: ["スミスショルダープレス", "smith shoulder press"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "arnold_press", name: "アーノルドプレス", english_name: "Arnold Press", part: "肩", secondary_parts: ["腕"], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["arnold dumbbell press"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "front_raise", name: "ダンベルフロントレイズ", english_name: "Dumbbell Front Raise", part: "肩", secondary_parts: [], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["フロントレイズ", "front raise"], rep_min: 10, rep_max: 15, increment: 1 },
  { key: "upright_row", name: "アップライトロウ", english_name: "Barbell Upright Row", part: "肩", secondary_parts: ["背中"], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["バーベルアップライトロー", "upright row"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "reverse_pec_deck", name: "リバースペックデック", english_name: "Reverse Pec Deck", part: "肩", secondary_parts: ["背中"], equipment: "machine", unit: "total", measurement: "reps", aliases: ["リアデルトマシンフライ", "reverse fly machine"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "cable_front_raise", name: "ケーブルフロントレイズ", english_name: "Cable Front Raise", part: "肩", secondary_parts: [], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ケーブルフロントレイズ", "cable front raise"], rep_min: 10, rep_max: 15, increment: 1 },
  { key: "incline_db_curl", name: "インクラインダンベルカール", english_name: "Incline Dumbbell Curl", part: "腕", secondary_parts: [], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["インクラインカール", "incline dumbbell curl", "インクラインDBカール"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "hammer_curl", name: "ハンマーカール", english_name: "Dumbbell Hammer Curl", part: "腕", secondary_parts: [], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["ダンベルハンマーカール", "hammer curl"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "barbell_curl", name: "バーベルカール", english_name: "Barbell Curl", part: "腕", secondary_parts: [], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["アームカール（バーベル）", "barbell biceps curl"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "preacher_curl", name: "プリーチャーカール（マシン）", english_name: "Machine Preacher Curl", part: "腕", secondary_parts: [], equipment: "machine", unit: "total", measurement: "reps", aliases: ["マシンプリーチャーカール", "preacher curl machine"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "cable_curl", name: "ケーブルカール", english_name: "Cable Curl", part: "腕", secondary_parts: [], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ケーブルアームカール", "cable biceps curl"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "concentration_curl", name: "コンセントレーションカール", english_name: "Concentration Curl", part: "腕", secondary_parts: [], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["コンセントレーションカール", "concentration curl"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "overhead_tri_ext", name: "ケーブルオーバーヘッドトライセプスエクステンション", english_name: "Cable Overhead Triceps Extension", part: "腕", secondary_parts: [], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ケーブルオーバーヘッドエクステンション", "overhead triceps extension", "オーバーヘッドトライセプスエクステンション"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "cable_pressdown", name: "ケーブルプレスダウン", english_name: "Cable Triceps Pressdown", part: "腕", secondary_parts: [], equipment: "cable", unit: "total", measurement: "reps", aliases: ["トライセプスプレスダウン", "cable pressdown", "triceps pushdown"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "narrow_push", name: "クローズグリップベンチプレス（スミス）", english_name: "Smith Machine Close-Grip Bench Press", part: "腕", secondary_parts: ["胸"], equipment: "smith", unit: "plate", measurement: "reps", aliases: ["ナロープレス（スミス）", "close grip smith bench press", "ナロープッシュ（スミス）"], rep_min: 6, rep_max: 12, increment: 2.5 },
  { key: "skull_crusher", name: "ライイングトライセプスエクステンション", english_name: "Lying Triceps Extension", part: "腕", secondary_parts: [], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["スカルクラッシャー", "skull crusher"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "db_overhead_tri_ext", name: "ダンベルオーバーヘッドトライセプスエクステンション", english_name: "Dumbbell Overhead Triceps Extension", part: "腕", secondary_parts: [], equipment: "dumbbell", unit: "total", measurement: "reps", aliases: ["ダンベルフレンチプレス", "dumbbell overhead triceps extension"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "db_kickback", name: "ダンベルキックバック", english_name: "Dumbbell Triceps Kickback", part: "腕", secondary_parts: [], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["トライセプスキックバック", "triceps kickback"], rep_min: 10, rep_max: 15, increment: 1 },
  { key: "dip_triceps", name: "トライセプスディップ", english_name: "Triceps Dip", part: "腕", secondary_parts: ["胸"], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["ディップス（腕狙い）", "triceps dips"], rep_min: 6, rep_max: 15, increment: 1 },
  { key: "squat", name: "バーベルスクワット", english_name: "Barbell Back Squat", part: "脚", secondary_parts: ["尻"], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["バックスクワット", "barbell squat"], rep_min: 5, rep_max: 10, increment: 2.5 },
  { key: "smith_squat", name: "スクワット（スミス）", english_name: "Smith Machine Squat", part: "脚", secondary_parts: ["尻"], equipment: "smith", unit: "plate", measurement: "reps", aliases: ["スミスマシンスクワット", "smith squat", "スミススクワット"], rep_min: 6, rep_max: 12, increment: 2.5 },
  { key: "leg_extension", name: "レッグエクステンション", english_name: "Machine Leg Extension", part: "脚", secondary_parts: [], equipment: "machine", unit: "total", measurement: "reps", aliases: ["レッグエクステンション（マシン）", "leg extension"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "leg_curl", name: "レッグカール（マシン・方式未指定）", english_name: "Machine Leg Curl", part: "脚", secondary_parts: ["尻"], equipment: "machine", unit: "total", measurement: "reps", aliases: ["レッグカール", "leg curl"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "leg_press", name: "レッグプレス", english_name: "Leg Press Machine", part: "脚", secondary_parts: ["尻"], equipment: "machine", unit: "total", measurement: "reps", aliases: ["レッグプレス（マシン）", "leg press"], rep_min: 8, rep_max: 15, increment: 5 },
  { key: "romanian_deadlift", name: "ルーマニアンデッドリフト", english_name: "Romanian Deadlift", part: "脚", secondary_parts: ["尻", "背中"], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["RDL", "romanian deadlift"], rep_min: 6, rep_max: 12, increment: 2.5 },
  { key: "db_romanian_deadlift", name: "ダンベルルーマニアンデッドリフト", english_name: "Dumbbell Romanian Deadlift", part: "脚", secondary_parts: ["尻"], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["ダンベルRDL", "dumbbell RDL"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "goblet_squat", name: "ゴブレットスクワット", english_name: "Goblet Squat", part: "脚", secondary_parts: ["尻"], equipment: "dumbbell", unit: "total", measurement: "reps", aliases: ["ダンベルゴブレットスクワット", "goblet squat"], rep_min: 8, rep_max: 15, increment: 1 },
  { key: "front_squat", name: "フロントスクワット", english_name: "Barbell Front Squat", part: "脚", secondary_parts: ["尻"], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["バーベルフロントスクワット", "front squat"], rep_min: 5, rep_max: 10, increment: 2.5 },
  { key: "bulgarian_split_squat", name: "ブルガリアンスクワット", english_name: "Bulgarian Split Squat", part: "脚", secondary_parts: ["尻"], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["ブルガリアンスプリットスクワット", "bulgarian split squat"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "walking_lunge", name: "ウォーキングランジ", english_name: "Walking Lunge", part: "脚", secondary_parts: ["尻"], equipment: "dumbbell", unit: "per_hand", measurement: "reps", aliases: ["ダンベルウォーキングランジ", "walking lunge"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "reverse_lunge", name: "リバースランジ", english_name: "Reverse Lunge", part: "脚", secondary_parts: ["尻"], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["バックランジ", "reverse lunge"], rep_min: 8, rep_max: 12, increment: 1 },
  { key: "hack_squat", name: "ハックスクワット", english_name: "Hack Squat Machine", part: "脚", secondary_parts: ["尻"], equipment: "machine", unit: "total", measurement: "reps", aliases: ["ハックスクワット（マシン）", "hack squat"], rep_min: 8, rep_max: 12, increment: 5 },
  { key: "smith_split_squat", name: "スミスブルガリアンスクワット", english_name: "Smith Machine Split Squat", part: "脚", secondary_parts: ["尻"], equipment: "smith", unit: "plate", measurement: "reps", aliases: ["スミススプリットスクワット", "smith split squat"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "hip_adduction", name: "ヒップアダクション", english_name: "Hip Adduction Machine", part: "脚", secondary_parts: [], equipment: "machine", unit: "total", measurement: "reps", aliases: ["アダクション", "hip adduction"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "hip_abduction", name: "ヒップアブダクション", english_name: "Hip Abduction Machine", part: "脚", secondary_parts: ["尻"], equipment: "machine", unit: "total", measurement: "reps", aliases: ["アブダクション", "hip abduction"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "calf_raise", name: "カーフレイズ（マシン・方式未指定）", english_name: "Machine Calf Raise", part: "脚", secondary_parts: [], equipment: "machine", unit: "total", measurement: "reps", aliases: ["カーフレイズ", "calf raise"], rep_min: 10, rep_max: 20, increment: 2.5 },
  { key: "standing_calf_raise", name: "スタンディングカーフレイズ", english_name: "Standing Calf Raise", part: "脚", secondary_parts: [], equipment: "machine", unit: "total", measurement: "reps", aliases: ["スタンディングカーフレイズ（マシン）", "standing calf raise"], rep_min: 10, rep_max: 20, increment: 2.5 },
  { key: "seated_calf_raise", name: "シーテッドカーフレイズ", english_name: "Seated Calf Raise", part: "脚", secondary_parts: [], equipment: "machine", unit: "total", measurement: "reps", aliases: ["シーテッドカーフレイズ（マシン）", "seated calf raise"], rep_min: 10, rep_max: 20, increment: 2.5 },
  { key: "seated_leg_curl", name: "シーテッドレッグカール", english_name: "Seated Leg Curl", part: "脚", secondary_parts: ["尻"], equipment: "machine", unit: "total", measurement: "reps", aliases: ["シーテッドレッグカール（マシン）", "seated leg curl"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "leg_curl_lying", name: "ライイングレッグカール", english_name: "Lying Leg Curl", part: "脚", secondary_parts: ["尻"], equipment: "machine", unit: "total", measurement: "reps", aliases: ["プローンレッグカール", "lying leg curl"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "hip_thrust", name: "バーベルヒップスラスト", english_name: "Barbell Hip Thrust", part: "尻", secondary_parts: ["脚"], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["ヒップスラスト", "hip thrust"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "glute_bridge", name: "グルートブリッジ", english_name: "Glute Bridge", part: "尻", secondary_parts: ["脚"], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["ヒップリフト", "glute bridge"], rep_min: 10, rep_max: 20, increment: 1 },
  { key: "cable_kickback", name: "ケーブルキックバック", english_name: "Cable Glute Kickback", part: "尻", secondary_parts: [], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ケーブルグルートキックバック", "cable kickback"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "db_hip_thrust", name: "ダンベルヒップスラスト", english_name: "Dumbbell Hip Thrust", part: "尻", secondary_parts: ["脚"], equipment: "dumbbell", unit: "total", measurement: "reps", aliases: ["ダンベルヒップスラスト", "dumbbell hip thrust"], rep_min: 8, rep_max: 15, increment: 1 },
  { key: "single_leg_glute_bridge", name: "シングルレッググルートブリッジ", english_name: "Single-Leg Glute Bridge", part: "尻", secondary_parts: ["脚"], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["片脚グルートブリッジ", "single leg glute bridge"], rep_min: 8, rep_max: 15, increment: 1 },
  { key: "good_morning", name: "グッドモーニング", english_name: "Barbell Good Morning", part: "尻", secondary_parts: ["脚", "背中"], equipment: "barbell", unit: "total", measurement: "reps", aliases: ["バーベルグッドモーニング", "good morning"], rep_min: 8, rep_max: 12, increment: 2.5 },
  { key: "cable_pull_through", name: "ケーブルプルスルー", english_name: "Cable Pull-Through", part: "尻", secondary_parts: ["脚"], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ケーブルプルスルー", "cable pull through"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "ab_roller", name: "アブローラー（膝コロ）", english_name: "Kneeling Ab Wheel Rollout", part: "腹", secondary_parts: [], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["膝コロ", "ab wheel rollout", "ab roller"], rep_min: 6, rep_max: 15, increment: 1 },
  { key: "cable_crunch", name: "ケーブルクランチ", english_name: "Cable Crunch", part: "腹", secondary_parts: [], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ケーブルアブドミナルクランチ", "cable crunch"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "pallof_press", name: "パロフプレス", english_name: "Pallof Press", part: "腹", secondary_parts: [], equipment: "cable", unit: "total", measurement: "reps", aliases: ["ケーブルパロフプレス", "pallof press"], rep_min: 8, rep_max: 15, increment: 1 },
  { key: "reverse_crunch", name: "リバースクランチ", english_name: "Reverse Crunch", part: "腹", secondary_parts: [], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["リバースクランチ", "reverse crunch"], rep_min: 10, rep_max: 20, increment: 1 },
  { key: "abdominal_crunch_machine", name: "アブドミナルクランチ（マシン）", english_name: "Machine Abdominal Crunch", part: "腹", secondary_parts: [], equipment: "machine", unit: "total", measurement: "reps", aliases: ["アブドミナルクランチ", "abdominal crunch machine"], rep_min: 10, rep_max: 15, increment: 2.5 },
  { key: "plank", name: "プランク", english_name: "Plank", part: "腹", secondary_parts: [], equipment: "bodyweight", unit: "bodyweight", measurement: "seconds", aliases: ["フロントプランク", "plank"], rep_min: 20, rep_max: 60, increment: 5 },
  { key: "side_plank", name: "サイドプランク", english_name: "Side Plank", part: "腹", secondary_parts: ["尻"], equipment: "bodyweight", unit: "bodyweight", measurement: "seconds", aliases: ["サイドブリッジ", "side plank"], rep_min: 15, rep_max: 45, increment: 5 },
  { key: "hanging_leg_raise", name: "ハンギングレッグレイズ", english_name: "Hanging Leg Raise", part: "腹", secondary_parts: ["腕"], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["ハンギングニーレイズ", "hanging leg raise"], rep_min: 6, rep_max: 15, increment: 1 },
  { key: "sit_up", name: "シットアップ", english_name: "Sit-Up", part: "腹", secondary_parts: [], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["腹筋運動", "sit up"], rep_min: 10, rep_max: 20, increment: 1 },
  { key: "bicycle_crunch", name: "バイシクルクランチ", english_name: "Bicycle Crunch", part: "腹", secondary_parts: [], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["バイシクルクランチ", "bicycle crunch"], rep_min: 10, rep_max: 20, increment: 1 },
  { key: "bouldering", name: "ボルダリング", english_name: "Bouldering", part: "その他", secondary_parts: ["背中", "腕"], equipment: "bodyweight", unit: "bodyweight", measurement: "reps", aliases: ["bouldering"], rep_min: 1, rep_max: 1, increment: 1 },
];

/** Legacy (previous app) exercise keys that were merged into standard entries. */
export const legacy_keys: Readonly<Record<string, string>> = {
  "imp_239fbb16": "db_shoulder_press",
  "imp_f717abb6": "seated_row",
  "imp_5e3eef59": "pec_fly"
};

const byKey = new Map<string, CatalogEntry>(CATALOG.map((e) => [e.key, e]));

/** Resolve a key (including legacy keys) to its catalog entry. */
export function getExercise(key: string): CatalogEntry | undefined {
  return byKey.get(legacy_keys[key] ?? key);
}
/** Canonical key for a possibly legacy key. */
export function canonicalKey(key: string): string {
  return legacy_keys[key] ?? key;
}

/** Legacy keys pointing at a given standard entry (for "duplicates merged" notes in the UI). */
export function legacyKeysFor(key: string): string[] {
  return Object.entries(legacy_keys).filter(([, v]) => v === key).map(([k]) => k);
}

const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\u3000・･\-_()（）]/g, "");

/** Effective recording unit of a set for an entry: seconds-based exercises are "time". */
export function unitFor(entry: CatalogEntry): WeightUnit {
  return entry.measurement === "seconds" ? "time" : entry.unit;
}

/** Find an entry whose name or alias exactly matches (normalized). Used by NLP; never fuzzy. */
export function findExactExercise(text: string): CatalogEntry | undefined {
  const q = normalize(text);
  if (!q) return undefined;
  for (const e of CATALOG) {
    if (normalize(e.name) === q || normalize(e.english_name) === q || e.key === q) return e;
    if (e.aliases.some((a) => normalize(a) === q)) return e;
  }
  return undefined;
}

/**
 * Search the catalog by name, alias, English name, part or equipment (substring, NFKC-normalized).
 * Results are ordered: exact name/alias match → name prefix → other matches, preserving catalog order inside groups.
 */
export function searchCatalog(q: string, opts: { part?: Part | ""; equipment?: Equipment | "" } = {}): CatalogEntry[] {
  const nq = normalize(q ?? "");
  const pool = CATALOG.filter((e) => (!opts.part || e.part === opts.part) && (!opts.equipment || e.equipment === opts.equipment));
  if (!nq) return pool;
  const ranked: { e: CatalogEntry; rank: number }[] = [];
  for (const e of pool) {
    const name = normalize(e.name), en = normalize(e.english_name);
    const aliases = e.aliases.map(normalize);
    const eqLabel = normalize(EQUIPMENT_LABELS[e.equipment]);
    let rank = -1;
    if (name === nq || aliases.includes(nq) || en === nq) rank = 0;
    else if (name.startsWith(nq) || aliases.some((a) => a.startsWith(nq))) rank = 1;
    else if (name.includes(nq) || aliases.some((a) => a.includes(nq)) || en.includes(nq)) rank = 2;
    else if (normalize(e.part) === nq || e.secondary_parts.some((p) => normalize(p) === nq)) rank = 3;
    else if (e.equipment === nq || eqLabel === nq || eqLabel.includes(nq)) rank = 3;
    if (rank >= 0) ranked.push({ e, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.e);
}

/* ---------- API types ---------- */
export type TrainingSession = { id: string; part: string; started_at: string; ended_at: string | null; notes: string | null; set_count?: number };
export type TrainingSet = {
  id: string; session_id: string; exercise_key: string; weight: number | null; reps: number | null; duration_sec: number | null;
  unit: WeightUnit | null; memo: string | null; created_at: string;
};
export type ExerciseRecord = {
  exercise_key: string; name: string; unit: WeightUnit | null; measurement: Measurement;
  best: { weight: number | null; reps: number | null; duration_sec: number | null; created_at: string; session_id: string } | null;
  est_1rm: { value: number; reference: boolean } | null;
  set_count: number;
};
