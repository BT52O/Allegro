-- Profiles: friends share one password and one music library, and each profile keeps its own playlists, likes and
-- history. "admin" is the owner's profile: it is locked with a 6-digit PIN and is the only one that can delete songs.
-- The owner's existing library data stays under the old 'state' key in kv and becomes the Admin's.
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color INTEGER NOT NULL DEFAULT 0,
  photo INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO profiles (id, name, color, photo, created) VALUES ('admin', 'the Admin', 0, 0, 0);
-- Who wrote each comment. Comments written before profiles existed were the owner's.
ALTER TABLE song_comments ADD COLUMN profile TEXT NOT NULL DEFAULT 'admin';
