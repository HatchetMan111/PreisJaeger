"use strict";

/**
 * Laufzeit-Konfiguration: SQLite-Tabelle `settings` schlaegt .env.
 * Beim ersten Start werden .env-Werte als Defaults importiert.
 * Die Einstellungs-Seite der Web UI schreibt hierher (kein Neustart noetig).
 */

const KEYS = [
  "LLM_PROVIDER",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "OPENROUTER_MAX_TOKENS",
  "OPENROUTER_TIMEOUT_MS",
  "ENABLE_FALLBACK",
  "BRAVE_API_KEY",
  "BRAVE_TIMEOUT_MS",
  "SHOP_IDS",
  "SHOP_TIMEOUT_MS",
];

let db = null;

function init(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const cur = Object.fromEntries(
    db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value])
  );
  const seed = {
    LLM_PROVIDER: "none",
    OPENROUTER_API_KEY: "",
    OPENROUTER_MODEL: "openai/gpt-4o-mini",
    OPENROUTER_MAX_TOKENS: "400",
    OPENROUTER_TIMEOUT_MS: "20000",
    ENABLE_FALLBACK: "false",
    BRAVE_API_KEY: "",
    BRAVE_TIMEOUT_MS: "15000",
    SHOP_IDS: "",
    SHOP_TIMEOUT_MS: "40000",
  };
  const ins = db.prepare("INSERT INTO settings(key, value) VALUES(?, ?)");
  for (const [k, def] of Object.entries(seed)) {
    if (!(k in cur)) {
      const envVal = process.env[k];
      ins.run(k, envVal != null && envVal !== "" ? String(envVal) : def);
    }
  }
}

/** Auch vor init() nutzbar (dann .env-Fallback). */
function get(key) {
  if (db) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (row) return row.value;
  }
  return process.env[key] || "";
}

function set(key, value) {
  if (!db) throw new Error("Config-Store nicht initialisiert");
  if (!KEYS.includes(key)) throw new Error("Unbekannter Einstellungs-Key: " + key);
  db.prepare(`INSERT INTO settings(key, value, updated_at)
    VALUES(?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(key, String(value == null ? "" : value));
}

function mask(value) {
  const v = String(value || "");
  if (!v) return "";
  if (v.length <= 8) return "•••• (gesetzt)";
  return "••••" + v.slice(-4) + " (gesetzt)";
}

function allMasked() {
  const out = {};
  for (const k of KEYS) out[k] = k.includes("KEY") ? mask(get(k)) : get(k);
  return out;
}

module.exports = { KEYS, init, get, set, allMasked };
