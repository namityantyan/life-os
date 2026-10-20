// Pure helpers for the ideas module (no D1 / AI dependencies, unit-tested).

export const IDEA_STATUSES = ["inbox", "someday", "next", "done"] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];
export const IDEA_STATUS_LABELS: Record<IdeaStatus, string> = { inbox: "未整理", someday: "いつか", next: "次にやる", done: "完了" };

export type IdeaMeta = { title: string; created: string; status: string; tags?: string[] };

/** First non-empty line of the raw text, trimmed to `max` chars. Used as the provisional title. */
export function firstLineTitle(raw: string, max = 40): string {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const cleaned = line.replace(/^#+\s*/, "");
  return (cleaned.length > max ? cleaned.slice(0, max) : cleaned) || "無題のアイデア";
}

const yamlStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** YAML front matter block for Obsidian: title, created (YYYY-MM-DD), status, tags. */
export function buildFrontMatter(meta: IdeaMeta): string {
  const tags = (meta.tags ?? []).map((t) => t.trim()).filter(Boolean);
  return [
    "---",
    `title: ${yamlStr(meta.title)}`,
    `created: ${meta.created.slice(0, 10)}`,
    `status: ${meta.status}`,
    `tags: [${tags.map(yamlStr).join(", ")}]`,
    "---",
  ].join("\n");
}

/** Full Obsidian-ready note: front matter + H1 + body. */
export function buildIdeaMarkdown(meta: IdeaMeta, body: string): string {
  return `${buildFrontMatter(meta)}\n\n# ${meta.title}\n\n${body.trim()}\n`;
}

/** Guarantees the markdown starts with a front matter block; replaces an existing one so title/status stay in sync. */
export function ensureFrontMatter(markdown: string, meta: IdeaMeta): string {
  const m = markdown.trimStart();
  const body = m.startsWith("---\n") ? m.replace(/^---\n[\s\S]*?\n---\n?/, "") : m;
  return `${buildFrontMatter(meta)}\n\n${body.trim()}\n`;
}

/** Safe .md filename derived from the title (keeps Japanese, strips path/OS-unsafe chars). */
export function slugFilename(title: string, ext = ".md"): string {
  const s = title.normalize("NFC").replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${s || "idea"}${ext}`;
}

/** Concatenates many ideas into one markdown document for bulk import. */
export function exportIdeasMarkdown(items: { title: string | null; raw_text: string; markdown: string | null; status: string; created_at: string }[]): string {
  return items.map((it) => {
    const title = it.title || firstLineTitle(it.raw_text);
    const meta = { title, created: it.created_at, status: it.status };
    return it.markdown ? ensureFrontMatter(it.markdown, meta) : buildIdeaMarkdown(meta, it.raw_text);
  }).join("\n\n");
}
