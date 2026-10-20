# Life OS — module conventions (read before writing a module)

## Layout
- `worker/modules/<name>/routes.ts` exports `routes: Hono<AppEnv>` (mounted at `/api/<name>`, already authenticated: `c.get("user")` is the user) and optionally `publicRoutes` (mounted at `/api/integrations/<name>`, must verify its own bearer token from env).
- `src/modules/<name>/Page.tsx` default-exports the page. Sub-routes: the page is mounted at `/<name>/*`, use `<Routes>` inside if needed.
- Shared types for a module go in `shared/<name>.ts` (frontend + worker both import `@shared/...`; the worker uses relative `../../../shared/...` because tsconfig paths differ — actually both tsconfigs map `@shared/*`, so use `@shared/x` everywhere).
- DB: tables already exist in `migrations/0001_init.sql`. If you need a column/table, add a NEW migration `migrations/000N_<name>.sql` (never edit 0001) and run `npm run db:migrate:local`.
- Helpers: `worker/core/db.ts` (`all/one/run/newId/getSetting/setSetting/jstDate`), `worker/core/ai.ts` (`chat`, `chatJson` — Workers AI with offline fallback), `worker/core/context.ts` (`buildLifeContext`, `adviseWithContext(env,userId,role,history)` — use this for every AI chat so advice uses cross-module data), `worker/core/notify.ts` (`notify(env,userId,{kind,title,body,url,dedupeKey})`).
- Validation: zod on every request body. Errors: throw or return `c.json({error},400)`.

## Frontend
- Use components from `@/components/ui` (Button, Card, Section, PageHeader, Stat, Badge, Input, Textarea, Select, Field, Toggle, Segmented, Modal, Skeleton, PageSkeleton, ListSkeleton, EmptyState, Stagger/Item, ChatPanel, useToast). Use `useApi<T>(path,{poll})` and `api.get/post/put/del` from `@/lib/api`; formatters `fmtYen/fmtNum/fmtDate/fmtDateTime/todayJst`.
- Tailwind v4 with semantic tokens: `bg-elevated bg-fill bg-subtle text-label text-label-2 text-label-3 text-accent bg-accent-soft text-green text-red text-orange border-separator`. Spacing/font sizes scale globally — never hardcode px font sizes; use text-xs…text-4xl. Use `tabular` class for numbers.
- Show `<PageSkeleton/>` (full-page skeleton) while the page's first load is pending. Animate lists with `<Stagger>`/`<Item>`; use `motion` for transitions. No marketing copy, no emoji headers, Japanese UI text, Apple-HIG minimal look (generous whitespace, few borders, one accent).
- Add `data-testid` on key interactive elements for e2e tests.
- `document.title` is set by `<PageHeader title>` → "Life OS｜<title>".

## Tests
- Unit: `tests/unit/<name>.test.ts` (vitest) for pure logic (put pure logic in `worker/modules/<name>/logic.ts` so it is testable without D1).
- E2E: `e2e/<name>.spec.ts` using `import { test, expect } from "./helpers"` and the `authed` fixture (`test("…", async ({ authed: page }) => …)`). Tests run against the local dev server (`npm run dev` on :5173) with a fresh local D1; make tests idempotent (create your own data, use unique titles). Run: `npx playwright test e2e/<name>.spec.ts --project=desktop`.
- Run `npx tsc -b` before finishing; it must pass.

## Data honesty rules (from the spec)
- Missing/stale values are shown as "—" or "未取得", never as 0 or as today's value. Distinguish estimated vs recorded values. Never fabricate history.
