"use strict";

/**
 * LLM-Abstraktion. Provider: "none" (Standard, deterministisch, keine Cloud)
 * oder "openrouter" (optional per OPENROUTER_API_KEY).
 * Faellt das LLM aus, laeuft die Suche mit Roh-Query + regelbasierter Begruendung weiter.
 */

const config = require("./config");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function cfg() {
  return {
    provider: (config.get("LLM_PROVIDER") || "none").toLowerCase(),
    apiKey: config.get("OPENROUTER_API_KEY") || "",
    model: config.get("OPENROUTER_MODEL") || "openai/gpt-4o-mini",
    maxTokens: parseInt(config.get("OPENROUTER_MAX_TOKENS") || "400", 10),
    timeoutMs: parseInt(config.get("OPENROUTER_TIMEOUT_MS") || "20000", 10),
  };
}

function modelName() {
  const c = cfg();
  return c.provider === "openrouter" && c.apiKey ? c.model : "none(rule-based)";
}

async function openrouterChat(system, user) {
  const c = cfg();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + c.apiKey,
          "HTTP-Referer": "http://localhost:8090",
          "X-Title": "PreisJaeger",
        },
        body: JSON.stringify({
          model: c.model,
          max_tokens: c.maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error("OpenRouter HTTP " + res.status);
      const data = await res.json();
      const text = data.choices && data.choices[0] && data.choices[0].message
        ? String(data.choices[0].message.content || "").trim()
        : "";
      if (!text) throw new Error("OpenRouter: leere Antwort");
      return text;
    } catch (err) {
      lastErr = err;
    }
  }
  clearTimeout(timer);
  throw lastErr;
}

function ruleNormalize(query) {
  return String(query || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Natuerlichsprachige Eingabe -> kompakter Suchstring. */
async function normalize(query) {
  const c = cfg();
  const fallback = ruleNormalize(query);
  if (c.provider !== "openrouter" || !c.apiKey) return fallback;
  try {
    const out = await openrouterChat(
      "Extrahiere aus der Eingabe Produktname plus wichtigste Kernattribute (Marke, Modell). Antworte NUR mit dem kompakten Suchstring, ohne Anrede, ohne Adjektive.",
      String(query)
    );
    return out.split("\n")[0].trim().slice(0, 120) || fallback;
  } catch (err) {
    return fallback;
  }
}

/** 2-3 Saetze: warum ist das der Preissieger. */
async function summarize({ query, winner, count, isNewBest, best }) {
  const line = winner
    ? `Guenstigstes Angebot: ${winner.name} fuer ${winner.priceInfo.display} bei ${winner.shopProviderName} (${count} Treffer).`
    : `Keine kaufbaren Angebote fuer "${query}" gefunden (${count} Treffer).`;
  const bestLine = isNewBest
    ? " Das ist ein neuer Bestpreis."
    : best
      ? ` Bisheriger Bestpreis: ${best.display} (${best.at}).`
      : "";
  const fallback = (line + bestLine).trim();
  const c = cfg();
  if (!winner || c.provider !== "openrouter" || !c.apiKey) return fallback;
  try {
    const out = await openrouterChat(
      "Fasse in 2-3 deutschen Saetzen zusammen, warum das genannte Angebot der Preissieger ist. Erwaehne Versand/Zoll, falls USA-Import.",
      `Anfrage: ${query}\nGewinner: ${winner.name} | ${winner.priceInfo.display} | ${winner.shopProviderName} | ${winner.url}\nTreffer gesamt: ${count}${bestLine}`
    );
    return out || fallback;
  } catch (err) {
    return fallback;
  }
}

/** Prueft einen OpenRouter-Key (fuer den Key-Test in den Einstellungen). */
async function testKey(apiKey) {
  const key = (apiKey || cfg().apiKey || "").trim();
  if (!key) throw new Error("Kein API-Key vorhanden");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      signal: ctrl.signal,
      headers: { Authorization: "Bearer " + key },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error("OpenRouter HTTP " + res.status + " (Key ungueltig?)");
    const data = await res.json();
    return { ok: true, models: Array.isArray(data.data) ? data.data.length : 0 };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

module.exports = { normalize, summarize, modelName, testKey };
