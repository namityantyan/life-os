import { describe, it, expect } from "vitest";
import { likePattern as notesLike } from "../../worker/modules/notes/logic";
import { likePattern as requestsLike } from "../../worker/modules/requests/logic";

describe("likePattern (notes / requests search)", () => {
  for (const [name, fn] of [["notes", notesLike], ["requests", requestsLike]] as const) {
    it(`${name}: escapes %, _ and backslash so they match literally`, () => {
      expect(fn("abc")).toBe("%abc%");
      expect(fn("100%")).toBe("%100\\%%");
      expect(fn("a_b")).toBe("%a\\_b%");
      expect(fn("c:\\x")).toBe("%c:\\\\x%");
    });
  }
});
