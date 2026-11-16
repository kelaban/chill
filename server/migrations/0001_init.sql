-- All timestamps are integer milliseconds since the epoch.

CREATE TABLE profiles (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- TMDB facts the ranker and library naming need, plus the raw detail payload.
CREATE TABLE titles (
  tmdb_id        INTEGER PRIMARY KEY,
  imdb_id        TEXT,
  title          TEXT NOT NULL,
  original_title TEXT,
  year           INTEGER,
  runtime_min    INTEGER,
  poster_path    TEXT,
  backdrop_path  TEXT,
  json           TEXT NOT NULL,
  fetched_at     INTEGER NOT NULL
);

CREATE TABLE http_cache (
  key        TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Keyed by title, never by file: files come and go, progress doesn't.
CREATE TABLE watch_state (
  profile_id      INTEGER NOT NULL REFERENCES profiles(id),
  tmdb_id         INTEGER NOT NULL,
  position_s      REAL NOT NULL,
  duration_s      REAL NOT NULL,
  watched         INTEGER NOT NULL DEFAULT 0,
  last_variant_id TEXT,
  last_release_id TEXT,
  last_edition    TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (profile_id, tmdb_id)
);

CREATE TABLE my_list (
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  tmdb_id    INTEGER NOT NULL,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (profile_id, tmdb_id)
);

CREATE TABLE searches (
  tmdb_id      INTEGER PRIMARY KEY,
  searched_at  INTEGER NOT NULL,
  result_count INTEGER NOT NULL
);

CREATE TABLE releases (
  id         TEXT NOT NULL,
  tmdb_id    INTEGER NOT NULL,
  raw_title  TEXT NOT NULL,
  indexer    TEXT NOT NULL,
  link       TEXT NOT NULL,
  imdb_id    TEXT,
  seeders    INTEGER NOT NULL,
  peers      INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  info_json  TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (tmdb_id, id)
);

CREATE TABLE acquisitions (
  id                INTEGER PRIMARY KEY,
  tmdb_id           INTEGER NOT NULL,
  tier              TEXT NOT NULL CHECK (tier IN ('instant', 'target')),
  release_id        TEXT,
  state             TEXT NOT NULL CHECK (state IN ('searching', 'queued', 'transferring', 'ready', 'failed', 'cancelled')),
  putio_transfer_id INTEGER,
  putio_file_id     INTEGER,
  percent           REAL,
  eta_s             INTEGER,
  message           TEXT,
  -- Set on a runner-up started by the race; points at the acquisition it races.
  races             INTEGER REFERENCES acquisitions(id),
  attempts          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  ready_at          INTEGER
);
CREATE INDEX acquisitions_title ON acquisitions (tmdb_id, state);

-- One playable copy in one place.
CREATE TABLE variants (
  id                TEXT PRIMARY KEY,
  tmdb_id           INTEGER NOT NULL,
  location          TEXT NOT NULL CHECK (location IN ('putio', 'local')),
  quality           TEXT NOT NULL CHECK (quality IN ('instant', 'target')),
  release_id        TEXT,
  acquisition_id    INTEGER REFERENCES acquisitions(id),
  putio_file_id     INTEGER,
  local_path        TEXT,
  size_bytes        INTEGER NOT NULL,
  resolution        INTEGER,
  dynamic_range     TEXT NOT NULL DEFAULT 'SDR',
  video_codec       TEXT,
  audio_codec       TEXT,
  container         TEXT,
  duration_s        REAL,
  label             TEXT NOT NULL,
  edition           TEXT,
  probe_json        TEXT,
  superseded_by     TEXT,
  pinned            INTEGER NOT NULL DEFAULT 0,
  ready             INTEGER NOT NULL DEFAULT 1,
  last_played_at    INTEGER,
  last_heartbeat_at INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX variants_title ON variants (tmdb_id);

-- t_to = a * t_from + b
CREATE TABLE variant_alignments (
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  a           REAL NOT NULL,
  b           REAL NOT NULL,
  residual_ms REAL,
  aligned     INTEGER NOT NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE jobs (
  id            INTEGER PRIMARY KEY,
  type          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  dedupe_key    TEXT,
  state         TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  run_after     INTEGER NOT NULL,
  last_error    TEXT,
  progress_json TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX jobs_due ON jobs (state, run_after);
CREATE UNIQUE INDEX jobs_dedupe ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running');

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE storage_events (
  id         INTEGER PRIMARY KEY,
  variant_id TEXT NOT NULL,
  tier       TEXT NOT NULL,
  action     TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  reason     TEXT,
  at         INTEGER NOT NULL
);

CREATE TABLE telemetry (
  id   INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  json TEXT NOT NULL,
  at   INTEGER NOT NULL
);

INSERT INTO profiles (name, color, created_at) VALUES ('Home', '#e50914', 0);
