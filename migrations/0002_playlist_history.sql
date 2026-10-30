-- Version history for playlists: one row per saved version (quick edits are folded together).
CREATE TABLE IF NOT EXISTS playlist_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pl TEXT NOT NULL,
  at INTEGER NOT NULL,
  base TEXT,
  data TEXT,
  changes TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS playlist_versions_pl_at ON playlist_versions (pl, at);
