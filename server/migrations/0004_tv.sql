-- TV shows. Each episode acts as a title with id = -episodes.id, so the whole
-- pipeline (acquisitions, variants, watch state, subtitles) works unchanged.

CREATE TABLE shows (
  imdb_id       TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  year          INTEGER,
  poster_url    TEXT,
  backdrop_url  TEXT,
  overview      TEXT,
  rating        REAL,
  networks_json TEXT NOT NULL DEFAULT '[]',
  genres_json   TEXT NOT NULL DEFAULT '[]',
  status        TEXT,
  season_count  INTEGER,
  fetched_at    INTEGER NOT NULL
);

CREATE TABLE episodes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  show_imdb       TEXT NOT NULL,
  season          INTEGER NOT NULL,
  episode         INTEGER NOT NULL,
  name            TEXT,
  overview        TEXT,
  air_date        TEXT,
  runtime_min     INTEGER,
  still_url       TEXT,
  -- chill.institute's own pick for this episode (gets a ranking bonus).
  pick_release_id TEXT,
  UNIQUE (show_imdb, season, episode)
);
CREATE INDEX episodes_show ON episodes (show_imdb, season, episode);
