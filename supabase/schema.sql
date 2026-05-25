-- Mobbin Library — Supabase Schema
-- Run this in the Supabase SQL editor before migrating data.

-- Disable RLS on all tables (private personal tool, service role key used throughout)
-- If you add public access later, enable RLS and add policies.

CREATE TYPE platform_type AS ENUM ('ios', 'web');

CREATE TABLE IF NOT EXISTS screens (
  id            TEXT PRIMARY KEY,
  app_name      TEXT NOT NULL,
  platform      platform_type NOT NULL,
  image_url     TEXT NOT NULL,
  mobbin_url    TEXT NOT NULL,
  image_path    TEXT,
  drive_file_id TEXT,
  drive_url     TEXT,
  flow_name     TEXT,
  app_category  TEXT,
  notes         TEXT,
  raw_response  JSONB NOT NULL DEFAULT '{}',
  cached_at     TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL,
  -- Generated FTS column — replaces SQLite FTS5 virtual table
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(app_name, '') || ' ' ||
      coalesce(flow_name, '') || ' ' ||
      coalesce(app_category, '') || ' ' ||
      coalesce(notes, '')
    )
  ) STORED
);

ALTER TABLE screens DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS screens_platform_idx    ON screens(platform);
CREATE INDEX IF NOT EXISTS screens_app_name_idx    ON screens(app_name);
CREATE INDEX IF NOT EXISTS screens_app_cat_idx     ON screens(app_category);
CREATE INDEX IF NOT EXISTS screens_last_seen_idx   ON screens(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS screens_search_idx      ON screens USING GIN(search_vector);

CREATE TABLE IF NOT EXISTS screen_queries (
  screen_id TEXT NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  query     TEXT NOT NULL,
  added_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (screen_id, query)
);

ALTER TABLE screen_queries DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS screen_queries_query_idx ON screen_queries(query);

CREATE TABLE IF NOT EXISTS screen_tags (
  screen_id TEXT NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  added_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (screen_id, tag)
);

ALTER TABLE screen_tags DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS screen_tags_tag_idx ON screen_tags(tag);

CREATE TABLE IF NOT EXISTS search_log (
  id           BIGSERIAL PRIMARY KEY,
  query        TEXT NOT NULL,
  platform     TEXT NOT NULL,
  mode         TEXT NOT NULL,
  limit_count  INTEGER NOT NULL,
  result_count INTEGER NOT NULL,
  hit_count    INTEGER NOT NULL DEFAULT 0,
  searched_at  TIMESTAMPTZ NOT NULL
);

ALTER TABLE search_log DISABLE ROW LEVEL SECURITY;

-- Key/value config store — used to persist Mobbin OAuth tokens for remote CCR jobs
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE config DISABLE ROW LEVEL SECURITY;

-- Postgres function used by getStats()
CREATE OR REPLACE FUNCTION get_stats()
RETURNS JSON
LANGUAGE SQL
STABLE
AS $$
  SELECT json_build_object(
    'totalScreens',   (SELECT COUNT(*)           FROM screens),
    'totalTags',      (SELECT COUNT(DISTINCT tag) FROM screen_tags),
    'totalQueries',   (SELECT COUNT(DISTINCT query) FROM screen_queries),
    'platforms',      (SELECT COALESCE(json_object_agg(platform, cnt), '{}')
                       FROM (SELECT platform::text, COUNT(*) AS cnt FROM screens GROUP BY platform) t),
    'topApps',        (SELECT COALESCE(json_agg(t ORDER BY t.count DESC), '[]')
                       FROM (SELECT app_name AS "appName", COUNT(*) AS count
                             FROM screens GROUP BY app_name ORDER BY count DESC LIMIT 10) t),
    'topTags',        (SELECT COALESCE(json_agg(t ORDER BY t.count DESC), '[]')
                       FROM (SELECT tag, COUNT(*) AS count
                             FROM screen_tags GROUP BY tag ORDER BY count DESC LIMIT 20) t),
    'recentSearches', (SELECT COUNT(*) FROM search_log
                       WHERE searched_at > NOW() - INTERVAL '7 days')
  );
$$;
