"use strict";

/**
 * Shop-Suche ueber mcp-shop-server (als Library eingebunden, kein MCP-Prozess noetig)
 * + EUR-Preis-Parsing + Preissieger-Logik + Produkt-Matching (ASIN/EAN/Name).
 */

let shopsUtils = null;
try {
  // Nur das Utils-Modul laden (index.js wuerde den MCP-Stdio-Server starten).
  shopsUtils = require("mcp-shop-server/utils/shops");
} catch (err) {
  throw new Error(
    "mcp-shop-server konnte nicht geladen werden. `npm ci` im app-Verzeichnis ausfuehren. Details: " + err.message
  );
}

const EU_DEFAULT_SHOPS = [
  "amazon-de", "amazon-fr", "amazon-it", "amazon-es",
  "ebay-com", "ebay-fr", "mydealz", "dealabs",
];
const US_IMPORT_SHOPS = new Set(["amazon-com", "ebay-com", "pepperdeals"]);

function getShops() {
  return shopsUtils.validShops.map((s) => ({
    id: s.id,
    name: s.name,
    url: String(s.url),
    deliverTo: s.deliverTo,
    whenToUse: s.whenToUse,
  }));
}

function resolveShopIds(wanted) {
  const valid = new Set(shopsUtils.validShops.map((s) => s.id));
  if (!wanted || wanted.length === 0) {
    return EU_DEFAULT_SHOPS.filter((id) => valid.has(id));
  }
  const ids = wanted.filter((id) => valid.has(id));
  if (ids.length === 0) throw new Error("Keine gueltigen Shop-IDs: " + wanted.join(","));
  return ids;
}

async function searchAll(query, shopIds, timeoutMs) {
  const shops = shopIds
    .map((id) => shopsUtils.validShops.find((s) => s.id === id))
    .filter(Boolean);

  const runOne = async (shop) => {
    try {
      const res = await shopsUtils[shop.function](query, shop.url);
      return (res || []).map((p) => ({
        ...p,
        shopProviderName: shop.name,
        shopProviderId: shop.id,
      }));
    } catch (err) {
      return { __error: `${shop.name}: ${err.message.split("\n")[0]}` };
    }
  };

  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
  const all = Promise.all(shopIds.map((id) => runOne(shops.find((s) => s.id === id))));
  const raced = await Promise.race([all, timeout]);

  if (raced === "timeout") {
    const settled = await Promise.allSettled(shopIds.map((id) => runOne(shops.find((s) => s.id === id))));
    const products = [];
    const errors = ["Suche nach " + timeoutMs / 1000 + "s gestoppt, Teilergebnisse."];
    for (const s of settled) {
      if (s.status === "fulfilled" && Array.isArray(s.value)) products.push(...s.value);
    }
    return { products, errors, timedOut: true };
  }
  const products = [];
  const errors = [];
  for (const r of raced) {
    if (Array.isArray(r)) products.push(...r);
    else if (r && r.__error) errors.push(r.__error);
  }
  return { products, errors, timedOut: false };
}

/** "€1.234,56" / "97,00 €" / "EUR 71.38" -> { cents, currency, display }. */
function toCents(numStr) {
  let t = String(numStr).trim();
  if (t.includes(",") && t.includes(".")) {
    if (t.lastIndexOf(",") > t.lastIndexOf(".")) t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
  } else if (t.includes(",")) {
    t = t.replace(/\./g, "").replace(",", ".");
  }
  const v = Math.round(parseFloat(t) * 100);
  return Number.isFinite(v) ? v : null;
}

function parsePrice(raw) {
  const s = String(raw || "");
  const short = s.slice(0, 80);
  let m = s.match(/€\s*([\d.,]+)/) || s.match(/EUR\s*([\d.,]+)/i) || s.match(/([\d.,]+)\s*€/);
  if (m) return { cents: toCents(m[1]), currency: "EUR", display: short };
  m = s.match(/£\s*([\d.,]+)/) || s.match(/([\d.,]+)\s*£/);
  if (m) return { cents: toCents(m[1]), currency: "GBP", display: short };
  m = s.match(/\$\s*([\d.,]+)/) || s.match(/USD\s*([\d.,]+)/i);
  if (m) return { cents: toCents(m[1]), currency: "USD", display: short };
  return { cents: null, currency: null, display: short };
}

function ratingNumber(r) {
  const m = String(r || "").replace(",", ".").match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

/** Preissieger: niedrigster EUR-Preis; Gleichstand -> besseres Rating. */
function pickWinner(products) {
  const eur = products.filter((p) => p.priceInfo.currency === "EUR" && p.priceInfo.cents != null);
  if (eur.length === 0) return null;
  eur.sort((a, b) => a.priceInfo.cents - b.priceInfo.cents || ratingNumber(b.rating) - ratingNumber(a.rating));
  return eur[0];
}

function amazonAsin(url) {
  const m = String(url || "").match(/\/dp\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}

function ebayItemId(url) {
  const m = String(url || "").match(/\/itm\/(?:.*?\/)?(\d{9,})/);
  return m ? m[1] : null;
}

function normalizeName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
}

/** Produkt-Schluessel fuer Bestpreis-Matching. ASIN/EAN = sicher, Name = Vermutung. */
function productKeyFor(product) {
  const asin = amazonAsin(product.url);
  if (asin) return { key: "asin:" + asin, confidence: "exact" };
  const ebay = ebayItemId(product.url);
  if (ebay) return { key: "ebay:" + ebay, confidence: "exact" };
  return { key: "name:" + normalizeName(product.name), confidence: "fuzzy" };
}

module.exports = {
  EU_DEFAULT_SHOPS,
  US_IMPORT_SHOPS,
  getShops,
  resolveShopIds,
  searchAll,
  toCents,
  parsePrice,
  pickWinner,
  productKeyFor,
};
