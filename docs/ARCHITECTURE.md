# Architecture

```mermaid
flowchart TD
    Browser[ブラウザ / PWA] -->|/api/*| Worker[Cloudflare Worker (Hono)]
    Worker --> D1[(D1 SQLite)]
    Worker --> KV[(KV: sessions, cache, leases)]
    Worker --> AI[Workers AI]
    Worker --> Push[Web Push (VAPID)]
    Worker --> DiscordAPI[Discord REST / Interactions]
    Worker --> Ext[Open-Meteo / Oura / Google / freee]
    Cron[Cron Triggers] --> Worker
    WinMT5[Windows MT5 Connector] -->|bearer token| Worker
    BackupPC[Backup PC] -->|bearer token| Worker
```

## Request flow
1. `worker/index.ts` mounts `/api/auth/*` (public), `/api/integrations/*` (token-authenticated machine endpoints), and everything else under `requireAuth`.
2. `requireAuth` validates the HMAC-signed session cookie against KV and rejects cross-site mutations.
3. Module routes live in `worker/modules/<name>/routes.ts`; pure logic in `logic.ts` is unit-tested.
4. `buildLifeContext` composes a cross-module snapshot; `adviseWithContext` prepends it to every AI chat.

## Scheduled jobs (`worker/cron.ts`)
| cron | work |
| --- | --- |
| `*/10 * * * *` | notification queue, due reminders, Oura sync |
| `0 * * * *` | freee balances, morning (07–09 JST, once/day), bedtime (23 JST), backup staleness |
| `0 22 * * *` | 07:00 JST: morning fallback, withholding reminder (1st–3rd), weekly summary (Monday) |

## Data honesty
Null means unknown; 0 means zero. Stale values carry their date. Partial totals are flagged. No history is fabricated.
