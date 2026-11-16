-- Subtitle tracks per stored copy, and each profile's choice per title.

CREATE TABLE subtitles (
  id         TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL,
  -- putio: put.io's subtitle key for the file · sidecar: path relative to the library · embedded: subtitle stream index (0:s:N)
  source     TEXT NOT NULL CHECK (source IN ('putio', 'sidecar', 'embedded')),
  ref        TEXT NOT NULL,
  language   TEXT,
  label      TEXT NOT NULL,
  forced     INTEGER NOT NULL DEFAULT 0,
  sdh        INTEGER NOT NULL DEFAULT 0,
  codec      TEXT,
  rank       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX subtitles_variant ON subtitles (variant_id);

-- NULL language = the viewer turned subtitles off for this title.
CREATE TABLE subtitle_choice (
  profile_id INTEGER NOT NULL,
  tmdb_id    INTEGER NOT NULL,
  language   TEXT,
  forced     INTEGER NOT NULL DEFAULT 0,
  sdh        INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, tmdb_id)
);

ALTER TABLE variants ADD COLUMN subs_checked_at INTEGER;
ALTER TABLE titles ADD COLUMN original_language TEXT;
