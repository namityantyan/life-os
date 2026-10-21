import { describe, it, expect } from "vitest";
import { parseJsonLoose } from "../../worker/core/ai";

describe("parseJsonLoose", () => {
  it("parses plain JSON and JSON wrapped in a code fence or prose", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('以下です。\n{"a":1}\nご確認ください。')).toEqual({ a: 1 });
  });

  it("repairs a reply cut off by the token limit, keeping the complete items", () => {
    const cut = '{"targets":null,"routines":[{"op":"add","slot":"breakfast","food_name":"ゆで卵","amount":2}],"estimates":[{"food_name":"ゆで卵","nutrition":{"energy_kc';
    const out = parseJsonLoose<{ routines: { food_name: string; amount: number }[] }>(cut);
    expect(out?.routines).toEqual([{ op: "add", slot: "breakfast", food_name: "ゆで卵", amount: 2 }]);
  });

  it("repairs truncation inside a string or right after a key", () => {
    expect(parseJsonLoose('{"a":1,"b":"途中で切れ')).toMatchObject({ a: 1 });
    expect(parseJsonLoose('{"a":1,"b":')).toEqual({ a: 1 });
    expect(parseJsonLoose('{"list":[1,2,3')).toEqual({ list: [1, 2, 3] });
  });

  it("returns undefined when there is no object at all", () => {
    expect(parseJsonLoose("no json here")).toBeUndefined();
    expect(parseJsonLoose("")).toBeUndefined();
  });
});
