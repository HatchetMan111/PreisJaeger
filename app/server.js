"use strict";

const express = require("express");
const path = require("path");
const db = require("./lib/db");
const shops = require("./lib/shops");
const llm = require("./lib/llm");
const fallback = require("./lib/fallback");

const PORT = parseInt(process.env.PORT || "8090", 10);
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "searches.db");
const SHOP_TIMEOUT_MS = parseInt(process.env.SHOP_TIMEOUT_MS || "40000", 10);
const ENABLE_FALLBACK = String(process.env.ENABLE_FALLBACK || "false").toLowerCase() === "true";

db.open(DB_PATH);

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: require("./package.json").version, llm: llm.modelName() });
});

app.get("/api/shops", (req, res) => {
  try {
    res.json({ shops: shops.getShops() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/search", async (req, res) => {
  const started = Date.now();
  const query = String((req.body && req.body.query) || "").trim();
  if (!query) return res.status(400).json({ error: "query fehlt" });

  const save = (row) => db.insertSearch({ error: null, ...row });
  try {
    const normalized = await llm.normalize(query);
    const shopIds = shops.resolveShopIds(
      String(process.env.SHOP_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)
    );

    let { products, errors, timedOut } = await shops.searchAll(normalized, shopIds, SHOP_TIMEOUT_MS);
    let source = "shops";
    if (products.length === 0 && ENABLE_FALLBACK) {
      const fb = await fallback.braveSearch(normalized);
      if (fb.products.length > 0) {
        products = fb.products;
        source = "brave";
      } else if (fb.error) {
        errors.push(fb.error);
      }
    }

    for (const p of products) p.priceInfo = shops.parsePrice(p.price);
    const winner = shops.pickWinner(products);
    const key = winner ? shops.productKeyFor(winner) : { key: null, confidence: null };

    // Historischer Bestpreis VOR dem Speichern lesen (nur fruehere Suchen).
    const best = key.key ? db.getBestPrice(key.key) : null;
    const isNewBest = Boolean(
      winner && winner.priceInfo.cents != null &&
      (!best || winner.priceInfo.cents < best.cents)
    );

    const summary = await llm.summarize({
      query: normalized, winner, count: products.length, isNewBest, best,
    });

    const id = save({
      query,
      normalized_query: normalized,
      product_key: key.key,
      product_key_confidence: key.confidence,
      winner_name: winner ? winner.name : null,
      winner_price_cents: winner ? winner.priceInfo.cents : null,
      winner_price_display: winner ? winner.priceInfo.display : null,
      winner_currency: winner ? winner.priceInfo.currency : null,
      winner_url: winner ? winner.url : null,
      winner_shop: winner ? winner.shopProviderName : null,
      winner_is_us_import: winner && shops.US_IMPORT_SHOPS.has(winner.shopProviderId) ? 1 : 0,
      all_results_json: JSON.stringify(products),
      result_count: products.length,
      source,
      model: llm.modelName(),
      duration_ms: Date.now() - started,
    });

    res.json({
      id, query, normalized_query: normalized, winner, best,
      is_new_best: isNewBest,
      best_confidence: key.confidence,
      results: products, source,
      errors, timed_out: timedOut,
      summary, duration_ms: Date.now() - started,
    });
  } catch (err) {
    try {
      save({
        query, normalized_query: query, product_key: null, product_key_confidence: null,
        winner_name: null, winner_price_cents: null, winner_price_display: null,
        winner_currency: null, winner_url: null, winner_shop: null, winner_is_us_import: 0,
        all_results_json: "[]", result_count: 0, source: "shops",
        model: llm.modelName(), duration_ms: Date.now() - started,
        error: err.message.split("\n")[0],
      });
    } catch (dbErr) {
      /* Verlauf darf Suche nie blockieren */
    }
    res.status(500).json({ error: err.message.split("\n")[0] });
  }
});

app.get("/api/history", (req, res) => {
  res.json({ history: db.getHistory(req.query.limit, req.query.q) });
});

app.get("/api/history/:id", (req, res) => {
  const row = db.getById(req.params.id);
  if (!row) return res.status(404).json({ error: "nicht gefunden" });
  let results = [];
  try { results = JSON.parse(row.all_results_json); } catch (err) { /* altes Format */ }
  const best = row.product_key ? db.getBestPrice(row.product_key) : null;
  res.json({ ...row, results, best });
});

app.get("/api/history/export", (req, res) => {
  const format = String(req.query.format || "json").toLowerCase();
  const rows = db.getHistory(500);
  if (format === "csv") {
    const head = "id,created_at,query,normalized_query,winner_name,winner_price_display,winner_shop,source,duration_ms";
    const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [r.id, r.created_at, r.query, r.normalized_query,
      r.winner_name, r.winner_price_display, r.winner_shop, r.source, r.duration_ms].map(esc).join(","));
    res.type("text/csv").send(head + "\n" + lines.join("\n"));
    return;
  }
  res.json({ history: rows });
});

app.listen(PORT, HOST, () => {
  console.log(`PreisJaeger lauscht auf http://${HOST}:${PORT} (llm=${llm.modelName()})`);
});
