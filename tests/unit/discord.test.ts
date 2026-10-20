import { describe, it, expect } from "vitest";
import {
  COMMAND_DEFINITIONS, generateLinkCode, isFromBot, isTrainingPhrase, moduleUrl, normalizeLinkCode, parseInteraction,
  resolveDashboardLink, resolveModule, truncateForDiscord, helpMessage,
} from "../../worker/modules/discord/logic";

describe("parseInteraction", () => {
  it("recognises PING", () => {
    expect(parseInteraction({ type: 1 })).toEqual({ kind: "ping" });
  });
  it("parses a slash command with options from a guild member", () => {
    const p = parseInteraction({
      type: 2, token: "tok", application_id: "app1", guild_id: "g1", channel_id: "c1",
      member: { user: { id: "u1", username: "nami" } },
      data: { name: "Chat", options: [{ name: "text", type: 3, value: "こんにちは" }] },
    });
    expect(p.kind).toBe("command");
    if (p.kind !== "command") return;
    expect(p.name).toBe("chat");
    expect(p.options).toEqual({ text: "こんにちは" });
    expect(p.guildId).toBe("g1"); expect(p.channelId).toBe("c1");
    expect(p.user?.id).toBe("u1"); expect(p.token).toBe("tok"); expect(p.applicationId).toBe("app1");
  });
  it("falls back to top-level user in DMs and tolerates missing options", () => {
    const p = parseInteraction({ type: 2, user: { id: "u2" }, data: { name: "dashboard" } });
    expect(p.kind).toBe("command");
    if (p.kind !== "command") return;
    expect(p.user?.id).toBe("u2"); expect(p.guildId).toBeNull(); expect(p.options).toEqual({});
  });
  it("reports unknown types", () => {
    expect(parseInteraction({ type: 3 })).toEqual({ kind: "unknown", type: 3 });
    expect(parseInteraction(null)).toEqual({ kind: "unknown", type: 0 });
  });
});

describe("isFromBot", () => {
  it("filters bots, system users and webhooks", () => {
    expect(isFromBot({ bot: true })).toBe(true);
    expect(isFromBot({ system: true })).toBe(true);
    expect(isFromBot({ webhook_id: "w1" })).toBe(true);
    expect(isFromBot({ id: "u1" } as any, "wh")).toBe(true);
  });
  it("passes humans", () => {
    expect(isFromBot({ bot: false })).toBe(false);
    expect(isFromBot(null)).toBe(false);
  });
});

describe("resolveDashboardLink", () => {
  it("maps 資産のURL to /assets", () => { expect(resolveDashboardLink("資産のURL")).toBe("/assets"); });
  it("maps dashboard requests to /", () => {
    expect(resolveDashboardLink("ダッシュボードのURL")).toBe("/");
    expect(resolveDashboardLink("dash")).toBe("/");
    expect(resolveDashboardLink("!dashboard")).toBe("/");
  });
  it("supports dash <module> and other aliases", () => {
    expect(resolveDashboardLink("dash 資産")).toBe("/assets");
    expect(resolveDashboardLink("/dash training")).toBe("/training");
    expect(resolveDashboardLink("トレーニングの画面を開きたい")).toBe("/training");
    expect(resolveDashboardLink("FXのリンク")).toBe("/fx");
    expect(resolveDashboardLink("カード利用のページ")).toBe("/cards");
  });
  it("returns null for ordinary conversation", () => {
    expect(resolveDashboardLink("こんにちは")).toBeNull();
    expect(resolveDashboardLink("今日の資産はどう？")).toBeNull();
    expect(resolveDashboardLink("")).toBeNull();
  });
});

describe("resolveModule / moduleUrl", () => {
  it("resolves by label, key and alias; empty → dashboard", () => {
    expect(resolveModule("資産")?.key).toBe("assets");
    expect(resolveModule("notes")?.key).toBe("notes");
    expect(resolveModule("筋トレ")?.key).toBe("training");
    expect(resolveModule("")?.key).toBe("dashboard");
    expect(resolveModule("存在しない")).toBeNull();
  });
  it("builds URLs without double slashes", () => {
    expect(moduleUrl("https://x.example/", "/assets")).toBe("https://x.example/assets");
    expect(moduleUrl("http://localhost:5173", "/")).toBe("http://localhost:5173/");
  });
});

describe("training phrase detection", () => {
  it("detects workout logs", () => {
    expect(isTrainingPhrase("ベンチプレス 60kg 10回 3セット")).toBe(true);
    expect(isTrainingPhrase("筋トレした")).toBe(true);
    expect(isTrainingPhrase("スクワット終わり")).toBe(true);
    expect(isTrainingPhrase("終了")).toBe(true);
    expect(isTrainingPhrase("胸トレ開始")).toBe(true);
  });
  it("ignores unrelated text", () => {
    expect(isTrainingPhrase("今日は眠い")).toBe(false);
    expect(isTrainingPhrase("資産のURL")).toBe(false);
  });
});

describe("link codes", () => {
  it("generates 6 chars from the unambiguous alphabet", () => {
    for (let i = 0; i < 20; i++) expect(generateLinkCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(generateLinkCode(() => 0)).toBe("AAAAAA");
  });
  it("normalises user input", () => { expect(normalizeLinkCode(" ab-cd 12 ")).toBe("ABCD12"); });
});

describe("commands & misc", () => {
  it("defines the documented command set", () => {
    expect(COMMAND_DEFINITIONS.map((c) => c.name).sort()).toEqual(["chat", "chathere", "chatoff", "chatstatus", "dash", "dashboard", "link", "reset"]);
    expect(COMMAND_DEFINITIONS.find((c) => c.name === "chat")?.options?.[0]).toMatchObject({ name: "text", required: true, type: 3 });
    expect(helpMessage()).toContain("/chat text");
  });
  it("truncates to Discord's 2000-char limit", () => {
    const t = truncateForDiscord("a".repeat(2500));
    expect(t.length).toBe(2000); expect(t.endsWith("…")).toBe(true);
    expect(truncateForDiscord("short")).toBe("short");
  });
});
