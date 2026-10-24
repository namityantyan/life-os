-- 画像生成: one row per request to the Mac imggen service, one row per resulting image.
-- Image bytes live outside the row: on the self-hosted server in a data directory (IMGGEN_STORE_DIR),
-- elsewhere (local dev / Cloudflare) in image_blobs. store_key names the object in either store.
CREATE TABLE image_generations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  prompt_text TEXT NOT NULL,          -- what the user typed (Japanese natural language or tags)
  tags TEXT NOT NULL,                 -- English danbooru tags sent to the service (quality tags added there)
  rating TEXT NOT NULL DEFAULT 'all_ages',
  count INTEGER NOT NULL DEFAULT 1,
  seed INTEGER,                       -- seed requested (null = random)
  job_id TEXT,                        -- the service's job id
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | error
  progress_done INTEGER NOT NULL DEFAULT 0,
  queue_position INTEGER,
  work_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_image_generations_user ON image_generations(user_id, created_at DESC);

CREATE TABLE image_files (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  filename TEXT NOT NULL,
  seed INTEGER,
  bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  mime TEXT NOT NULL DEFAULT 'image/png',
  store_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (generation_id, idx)
);
CREATE INDEX idx_image_files_generation ON image_files(generation_id);

CREATE TABLE image_blobs (
  key TEXT PRIMARY KEY,
  data BLOB NOT NULL
);
