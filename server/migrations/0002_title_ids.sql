-- TMDB id ↔ IMDb id, learned from whichever catalog is in use (Cinemeta needs
-- it to look titles up by IMDb id while chill keys everything by TMDB id).
CREATE TABLE title_ids (
  tmdb_id INTEGER PRIMARY KEY,
  imdb_id TEXT NOT NULL
);
CREATE INDEX title_ids_imdb ON title_ids (imdb_id);
