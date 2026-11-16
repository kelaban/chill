-- Scrub-preview thumbnails (trickplay) generated from a home copy: the sheet
-- layout as JSON, or NULL until generated. Sheets live in cacheDir/trickplay/<variant>/.
ALTER TABLE variants ADD COLUMN trickplay_json TEXT;
