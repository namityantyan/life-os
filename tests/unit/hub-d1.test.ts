import { describe, it, expect } from "vitest";
import { D1Shim, migrate } from "../../hub/d1";

describe("hub D1 shim", () => {
  it("supports prepare/bind/all/first/run/batch with D1 semantics", async () => {
    const db = new D1Shim(":memory:");
    migrate(db, [{ name: "0001.sql", sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER)" }]);
    migrate(db, [{ name: "0001.sql", sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" }]); // applied once only
    const r = await db.prepare("INSERT INTO t (name, flag) VALUES (?, ?)").bind("a", true).run();
    expect(r.meta.changes).toBe(1);
    await db.batch([db.prepare("INSERT INTO t (name, flag) VALUES (?, ?)").bind("b", undefined), db.prepare("INSERT INTO t (name) VALUES (?)").bind("c")]);
    const rows = (await db.prepare("SELECT name, flag FROM t ORDER BY id").all<{ name: string; flag: number | null }>()).results;
    expect(rows).toEqual([{ name: "a", flag: 1 }, { name: "b", flag: null }, { name: "c", flag: null }]);
    expect(await db.prepare("SELECT name FROM t WHERE id=?").bind(99).first()).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) n FROM t").first("n")).toBe(3);
    await expect(db.batch([db.prepare("INSERT INTO t (id, name) VALUES (1, 'dup')")])).rejects.toThrow();
    expect(await db.prepare("SELECT COUNT(*) n FROM t").first("n")).toBe(3); // batch rolled back
  });
});
