"use strict";

const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  product_key TEXT,
  product_key_confidence TEXT,
  winner_name TEXT,
  winner_price_cents INTEGER,
  winner_price_display TEXT,
  winner_currency TEXT,
  winner_url TEXT,
  winner_shop TEXT,
  winner_is_us_import INTEGER DEFAULT 0,
  all_results_json TEXT NOT NULL DEFAULT '[]',
  result_count INTEGER DEFAULT 0,
  source TEXT DEFAULT 'shops',
  model TEXT,
  duration_ms INTEGER,
  error TEXT,
  created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_searches_created ON searches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_searches_product ON searches(product_key, winner_price_cents);
`;

let db = null;

function open(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

function insertSearch(row) {
  const stmt = db.prepare(`INSERT INTO searches
    (query, normalized_query, product_key, product_key_confidence, winner_name,
     winner_price_cents, winner_price_display, winner_currency, winner_url, winner_shop,
     winner_is_us_import, all_results_json, result_count, source, model, duration_ms, error)
    VALUES (@query, @normalized_query, @product_key, @product_key_confidence, @winner_name,
     @winner_price_cents, @winner_price_display, @winner_currency, @winner_url, @winner_shop,
     @winner_is_us_import, @all_results_json, @result_count, @source, @model, @duration_ms, @error)`);
  return stmt.run(row).lastInsertRowid;
}

/** Historischer Bestpreis (Tiefstpreis) fuer einen product_key ueber alle bisherigen Suchen. */
function getBestPrice(productKey) {
  if (!productKey) return null;
  const row = db.prepare(`SELECT winner_price_cents AS cents, winner_price_display AS display,
      winner_url AS url, winner_shop AS shop, winner_name AS name, created_at AS at
    FROM searches
    WHERE product_key = ? AND winner_price_cents IS NOT NULL
    ORDER BY winner_price_cents ASC, created_at ASC LIMIT 1`).get(productKey);
  return row || null;
}

function getHistory(limit, q) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  if (q) {
    return db.prepare(`SELECT id, query, normalized_query, winner_name, winner_price_display,
        winner_shop, source, duration_ms, created_at
      FROM searches WHERE query LIKE ? OR normalized_query LIKE ? OR winner_name LIKE ?
      ORDER BY created_at DESC LIMIT ?`).all(`%${q}%`, `%${q}%`, `%${q}%`, lim);
  }
  return db.prepare(`SELECT id, query, normalized_query, winner_name, winner_price_display,
      winner_shop, source, duration_ms, created_at
    FROM searches ORDER BY created_at DESC LIMIT ?`).all(lim);
}

function getById(id) {
  return db.prepare("SELECT * FROM searches WHERE id = ?").get(id) || null;
}

module.exports = { open, insertSearch, getBestPrice, getHistory, getById };
