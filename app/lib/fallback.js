"use strict";

/**
 * Optionale Fallback-Stufe, wenn die Shop-Suche 0 Treffer liefert.
 * Aktuell: Brave Search API (nur Web-Links, keine strukturierten Preise).
 * Firecrawl ist als naechste Stufe vorgesehen (siehe README, Roadmap).
 */

async function braveSearch(query) {
  const apiKey = process.env.BRAVE_API_KEY || "";
  if (!apiKey) return { products: [], error: "BRAVE_API_KEY nicht gesetzt" };
  const timeoutMs = parseInt(process.env.BRAVE_TIMEOUT_MS || "15000", 10);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = "https://api.search.brave.com/res/v1/web/search?q=" +
      encodeURIComponent(query + " kaufen Preis") + "&count=10&country=DE&search_lang=de";
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) return { products: [], error: "Brave HTTP " + res.status };
    const data = await res.json();
    const items = (data.web && data.web.results) || [];
    return {
      products: items.map((r) => ({
        name: String(r.title || "").slice(0, 120),
        price: "",
        url: r.url || "",
        rating: "",
        reviewsCount: "",
        shopProviderName: "Brave-Fallback",
        shopProviderId: "brave",
        description: String(r.description || "").slice(0, 200),
      })),
      error: null,
    };
  } catch (err) {
    clearTimeout(timer);
    return { products: [], error: "Brave: " + err.message.split("\n")[0] };
  }
}

module.exports = { braveSearch };
