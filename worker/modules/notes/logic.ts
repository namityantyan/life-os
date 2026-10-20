// Pure helpers for the notes module (unit-tested).

/** LIKE pattern for a substring search; `%`, `_` and `\` in the query are matched literally (use with `ESCAPE '\'`). */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;
