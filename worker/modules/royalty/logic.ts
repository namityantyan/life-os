/** Pure royalty-mail classification: which distributor sent a statement notice, and for which month. */

export const PROVIDERS = ["nextone", "dcoret", "mcjp", "rights_services", "ponycanyon", "basemint", "unknown"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type RoyaltyStatus = "target" | "review" | "excluded";

export const PROVIDER_LABELS: Record<Provider, string> = {
  nextone: "NexTone", dcoret: "D-Coret", mcjp: "MCJP", rights_services: "rights.services", ponycanyon: "ポニーキャニオン", basemint: "BASEMINT", unknown: "不明",
};
export const PROVIDER_PORTALS: Partial<Record<Provider, string>> = {
  nextone: "https://www.nex-tone.co.jp/", dcoret: "https://d-coret.jp/", mcjp: "https://www.mcjp.jp/", rights_services: "https://rights.services/", ponycanyon: "https://www.ponycanyon.co.jp/", basemint: "https://basemint.jp/",
};

type Rule = { provider: Provider; senders: RegExp[]; subjects: RegExp[] };
const RULES: Rule[] = [
  { provider: "nextone", senders: [/nex-tone\.co\.jp/i, /nextone/i], subjects: [/nextone/i, /ネクストーン/, /配信使用料分配明細/] },
  { provider: "dcoret", senders: [/d-coret/i, /dcoret/i], subjects: [/d-?coret/i, /ディーコレット/] },
  { provider: "mcjp", senders: [/mcjp\.jp/i, /@mcjp/i], subjects: [/\bMCJP\b/i, /エムシージェイピー/] },
  { provider: "rights_services", senders: [/rights\.services/i, /rights-services/i], subjects: [/rights\.?services/i] },
  { provider: "ponycanyon", senders: [/ponycanyon/i, /pony-canyon/i], subjects: [/ポニーキャニオン/, /pony ?canyon/i] },
  { provider: "basemint", senders: [/basemint/i], subjects: [/basemint/i, /ベースミント/] },
];

/** Statement-ish vocabulary: when present with a known provider → target. */
const STATEMENT_WORDS = [/明細/, /分配/, /精算/, /支払(い)?通知/, /支払明細/, /royalt/i, /statement/i, /distribution/i, /印税/, /使用料/, /収益/];
/** Everyday purchase receipts / noise: excluded regardless of provider. */
const EXCLUDE_WORDS = [/starbucks/i, /スターバックス/, /google ?play/i, /app ?store/i, /apple\.com/i, /amazon/i, /ご注文(の)?(確認|受付|領収)/, /購入(の)?(確認|明細)/, /order (confirmation|receipt)/i, /your receipt/i, /ご利用明細(の)?(お知らせ|確定)/, /クレジットカード/, /newsletter/i, /メールマガジン/, /メルマガ/, /unsubscribe/i, /パスワード/, /password/i, /ログイン/, /login/i];

export type Classification = { provider: Provider; status: RoyaltyStatus; reason: string };

export function classifyRoyaltyMail(mail: { from?: string | null; subject?: string | null; body?: string | null }): Classification {
  const from = mail.from ?? ""; const subject = mail.subject ?? ""; const body = mail.body ?? "";
  const text = `${subject}\n${body}`;
  const excluded = EXCLUDE_WORDS.find((re) => re.test(subject) || re.test(from));
  let provider: Provider = "unknown";
  let via = "";
  for (const r of RULES) {
    if (r.senders.some((re) => re.test(from))) { provider = r.provider; via = "送信元"; break; }
  }
  if (provider === "unknown") for (const r of RULES) {
    if (r.subjects.some((re) => re.test(subject))) { provider = r.provider; via = "件名"; break; }
  }
  if (provider === "unknown") for (const r of RULES) {
    if (r.subjects.some((re) => re.test(body))) { provider = r.provider; via = "本文"; break; }
  }
  if (excluded) return { provider, status: "excluded", reason: `購入明細・通知系の語を含む (${excluded.source})` };
  const statement = STATEMENT_WORDS.some((re) => re.test(text));
  if (provider !== "unknown" && statement) return { provider, status: "target", reason: `${via}で${PROVIDER_LABELS[provider]}と判定、明細語あり` };
  if (provider !== "unknown") return { provider, status: "review", reason: `${via}で${PROVIDER_LABELS[provider]}と判定、明細語なし` };
  if (statement) return { provider: "unknown", status: "review", reason: "明細語はあるが配信元が不明" };
  return { provider: "unknown", status: "excluded", reason: "配信元も明細語も該当なし" };
}

/** Extract the statement's target month as YYYY-MM from subject (first) then body. Supports 2026年3月 / 2026/03 / 2026-03 / 2026.03 / 令和8年3月. */
export function extractTargetMonth(subject?: string | null, body?: string | null): string | null {
  for (const src of [subject ?? "", body ?? ""]) {
    const m1 = src.match(/(20\d{2})\s*年\s*(1[0-2]|0?[1-9])\s*月/);
    if (m1) return `${m1[1]}-${m1[2].padStart(2, "0")}`;
    const m2 = src.match(/(20\d{2})\s*[\/\-.]\s*(1[0-2]|0?[1-9])(?![\d])/);
    if (m2) return `${m2[1]}-${m2[2].padStart(2, "0")}`;
    const m3 = src.match(/令和\s*(\d{1,2})\s*年\s*(1[0-2]|0?[1-9])\s*月/);
    if (m3) return `${2018 + Number(m3[1])}-${m3[2].padStart(2, "0")}`;
  }
  return null;
}
