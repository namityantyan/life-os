import { describe, it, expect } from "vitest";
import { buildFrontMatter, buildIdeaMarkdown, ensureFrontMatter, exportIdeasMarkdown, firstLineTitle, slugFilename } from "../../worker/modules/ideas/logic";

describe("ideas logic", () => {
  it("firstLineTitle takes the first non-empty line, strips markdown heading and truncates", () => {
    expect(firstLineTitle("\n\n# 朝の散歩を習慣にする\n詳細")).toBe("朝の散歩を習慣にする");
    expect(firstLineTitle("a".repeat(100))).toHaveLength(40);
    expect(firstLineTitle("   ")).toBe("無題のアイデア");
  });

  it("buildFrontMatter emits YAML with title/created/status/tags and escapes quotes", () => {
    const fm = buildFrontMatter({ title: 'He said "hi"', created: "2026-10-21T01:02:03Z", status: "inbox", tags: ["music", "idea"] });
    expect(fm.split("\n")).toEqual(["---", 'title: "He said \\"hi\\""', "created: 2026-10-21", "status: inbox", 'tags: ["music", "idea"]', "---"]);
  });

  it("buildIdeaMarkdown wraps body with front matter and H1", () => {
    const md = buildIdeaMarkdown({ title: "テスト", created: "2026-10-21", status: "next" }, "本文\n");
    expect(md).toBe('---\ntitle: "テスト"\ncreated: 2026-10-21\nstatus: next\ntags: []\n---\n\n# テスト\n\n本文\n');
  });

  it("ensureFrontMatter replaces an existing block and adds one when missing", () => {
    const meta = { title: "T", created: "2026-01-01", status: "done" };
    const replaced = ensureFrontMatter('---\ntitle: "old"\nstatus: inbox\n---\n\n# T\n\nbody', meta);
    expect(replaced.startsWith('---\ntitle: "T"\ncreated: 2026-01-01\nstatus: done\n')).toBe(true);
    expect(replaced).not.toContain("old");
    expect(replaced.trim().endsWith("body")).toBe(true);
    expect(ensureFrontMatter("plain", meta)).toBe('---\ntitle: "T"\ncreated: 2026-01-01\nstatus: done\ntags: []\n---\n\nplain\n');
  });

  it("slugFilename keeps Japanese, strips unsafe characters and falls back", () => {
    expect(slugFilename("朝の散歩: 習慣化/計画?")).toBe("朝の散歩-習慣化-計画.md");
    expect(slugFilename("  a  b  ")).toBe("a-b.md");
    expect(slugFilename("///")).toBe("idea.md");
    expect(slugFilename("x".repeat(200))).toHaveLength(80 + 3);
  });

  it("exportIdeasMarkdown concatenates notes, using raw text when not organized", () => {
    const out = exportIdeasMarkdown([
      { title: null, raw_text: "最初の行\n続き", markdown: null, status: "inbox", created_at: "2026-10-01T00:00:00Z" },
      { title: "整理済み", raw_text: "raw", markdown: "---\ntitle: \"整理済み\"\n---\n\n# 整理済み\n\n本文", status: "next", created_at: "2026-10-02T00:00:00Z" },
    ]);
    expect(out).toContain('title: "最初の行"');
    expect(out).toContain("最初の行\n続き");
    expect(out).toContain('title: "整理済み"\ncreated: 2026-10-02\nstatus: next');
    expect(out.match(/^---$/gm)?.length).toBe(4);
  });
});
