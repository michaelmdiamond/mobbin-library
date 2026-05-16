import Database from 'better-sqlite3'
import * as path from 'path'
import * as fs from 'fs'

const DB_PATH = path.join(__dirname, '..', 'mobbin.db')

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  applySchema(_db)
  return _db
}

export function closeDb(): void {
  _db?.close()
  _db = null
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS screens (
      id             TEXT PRIMARY KEY,
      app_name       TEXT NOT NULL,
      platform       TEXT NOT NULL CHECK(platform IN ('ios','web')),
      image_url      TEXT NOT NULL,
      mobbin_url     TEXT NOT NULL,
      image_path     TEXT,
      image_data     BLOB,
      flow_name      TEXT,
      app_category   TEXT,
      notes          TEXT,
      raw_response   TEXT NOT NULL,
      cached_at      TEXT NOT NULL,
      last_seen_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS screen_queries (
      screen_id  TEXT NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
      query      TEXT NOT NULL,
      added_at   TEXT NOT NULL,
      PRIMARY KEY (screen_id, query)
    );

    CREATE TABLE IF NOT EXISTS screen_tags (
      screen_id  TEXT NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
      tag        TEXT NOT NULL,
      added_at   TEXT NOT NULL,
      PRIMARY KEY (screen_id, tag)
    );

    CREATE TABLE IF NOT EXISTS search_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      query        TEXT NOT NULL,
      platform     TEXT NOT NULL,
      mode         TEXT NOT NULL,
      limit_count  INTEGER NOT NULL,
      result_count INTEGER NOT NULL,
      hit_count    INTEGER NOT NULL DEFAULT 0,
      searched_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_screens_platform    ON screens(platform);
    CREATE INDEX IF NOT EXISTS idx_screens_app_name    ON screens(app_name);
    CREATE INDEX IF NOT EXISTS idx_screens_app_cat     ON screens(app_category);
    CREATE INDEX IF NOT EXISTS idx_screens_last_seen   ON screens(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_screen_queries_q    ON screen_queries(query);
    CREATE INDEX IF NOT EXISTS idx_screen_tags_tag     ON screen_tags(tag);

    CREATE VIRTUAL TABLE IF NOT EXISTS screens_fts USING fts5(
      id UNINDEXED,
      app_name,
      flow_name,
      app_category,
      notes,
      content='screens',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS screens_fts_insert AFTER INSERT ON screens BEGIN
      INSERT INTO screens_fts(rowid, id, app_name, flow_name, app_category, notes)
      VALUES (new.rowid, new.id, new.app_name, new.flow_name, new.app_category, new.notes);
    END;

    CREATE TRIGGER IF NOT EXISTS screens_fts_update AFTER UPDATE ON screens BEGIN
      INSERT INTO screens_fts(screens_fts, rowid, id, app_name, flow_name, app_category, notes)
      VALUES ('delete', old.rowid, old.id, old.app_name, old.flow_name, old.app_category, old.notes);
      INSERT INTO screens_fts(rowid, id, app_name, flow_name, app_category, notes)
      VALUES (new.rowid, new.id, new.app_name, new.flow_name, new.app_category, new.notes);
    END;

    CREATE TRIGGER IF NOT EXISTS screens_fts_delete AFTER DELETE ON screens BEGIN
      INSERT INTO screens_fts(screens_fts, rowid, id, app_name, flow_name, app_category, notes)
      VALUES ('delete', old.rowid, old.id, old.app_name, old.flow_name, old.app_category, old.notes);
    END;
  `)
}
