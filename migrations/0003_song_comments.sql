-- Your own comments on songs (the Comments tab in Now Playing).
CREATE TABLE IF NOT EXISTS song_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song TEXT NOT NULL,
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  liked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS song_comments_song ON song_comments (song, at);
