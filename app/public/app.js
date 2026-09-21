"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

function switchTab(which) {
  for (const t of ["search", "history", "settings"]) {
    $("tab-" + t).classList.toggle("active", which === t);
    $("view-" + t).classList.toggle("hidden", which !== t);
  }
  if (which === "history") loadHistory();
  if (which === "settings") loadSettings();
}
$("tab-search").onclick = () => switchTab("search");
$("tab-history").onclick = () => switchTab("history");
$("tab-settings").onclick = () => switchTab("settings");

$("search-form").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  $("status").textContent = "Suche läuft (bis ~60 s) …";
  $("summary").classList.add("hidden");
  $("winner").classList.add("hidden");
  $("results").innerHTML = "";
  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "Fehler");
    $("status").textContent = `${d.results.length} Treffer in ${(d.duration_ms / 1000).toFixed(1)} s · Quelle: ${esc(d.source)}`;

    $("summary").innerHTML = `<div class="card">${esc(d.summary)}</div>`;
    $("summary").classList.remove("hidden");

    if (d.winner) {
      let bestHtml = "";
      if (d.is_new_best) {
        bestHtml = `<span class="badge best">Neuer Bestpreis!</span>`;
      } else if (d.best) {
        bestHtml = `<span class="badge src">Bestpreis bisher: ${esc(d.best.display)} (${esc(d.best.at)})</span>` +
          (d.best_confidence === "fuzzy" ? `<span class="mut">vermutlich gleiches Produkt</span>` : "");
      }
      $("winner").innerHTML = `<div class="card winner">
        <span class="badge win">Preissieger</span>${bestHtml}
        <div class="price">${esc(d.winner.priceInfo.display)}</div>
        <div><a href="${esc(d.winner.url)}" target="_blank" rel="noopener">${esc(d.winner.name)}</a></div>
        <div class="mut">${esc(d.winner.shopProviderName)}${d.winner.shopProviderId && ["amazon-com", "ebay-com", "pepperdeals"].includes(d.winner.shopProviderId) ? " · USA-Import: ggf. Versand + Zoll" : ""}</div>
      </div>`;
      $("winner").classList.remove("hidden");
    }

    $("results").innerHTML = d.results.map((p) => `<div class="card">
      <div class="price">${esc((p.priceInfo && p.priceInfo.display) || p.price || "–")}</div>
      <div><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a></div>
      <div class="mut">${esc(p.shopProviderName || "")}${p.rating ? " · ★ " + esc(p.rating) : ""}</div>
    </div>`).join("") || `<div class="mut">Keine Treffer.</div>`;
  } catch (err) {
    $("status").textContent = "Fehler: " + err.message;
  }
};

async function loadHistory() {
  const q = $("hq").value.trim();
  const res = await fetch("/api/history?limit=100" + (q ? "&q=" + encodeURIComponent(q) : ""));
  const d = await res.json();
  $("history-body").innerHTML = d.history.map((r) => `<tr data-id="${r.id}">
    <td>${esc(r.created_at)}</td><td>${esc(r.query)}</td>
    <td>${esc(r.winner_name || "–")}</td><td>${esc(r.winner_price_display || "–")}</td>
    <td>${esc(r.source)}</td><td>${((r.duration_ms || 0) / 1000).toFixed(1)} s</td>
  </tr>`).join("");
  document.querySelectorAll("#history-body tr").forEach((tr) => {
    tr.onclick = () => showDetail(tr.dataset.id);
  });
}
$("hsearch").onclick = loadHistory;

async function saveSetting(key, value) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || "Speichern fehlgeschlagen");
  return d.settings;
}

async function loadSettings() {
  const [sres, shopsRes] = await Promise.all([fetch("/api/settings"), fetch("/api/shops")]);
  const { settings: s, shop_defaults } = await sres.json();
  const { shops } = await shopsRes.json();
  $("s-provider").value = s.LLM_PROVIDER || "none";
  $("s-or-model").value = s.OPENROUTER_MODEL || "";
  $("s-or-hint").textContent = s.OPENROUTER_API_KEY
    ? "Gespeichert: " + s.OPENROUTER_API_KEY + " (Feld leer lassen = behalten)" : "Kein Key gespeichert.";
  $("s-timeout").value = s.SHOP_TIMEOUT_MS || "40000";
  $("s-fb").checked = s.ENABLE_FALLBACK === "true";
  $("s-brave-hint").textContent = s.BRAVE_API_KEY
    ? "Gespeichert: " + s.BRAVE_API_KEY + " (Feld leer lassen = behalten)" : "Kein Key gespeichert.";
  const active = (s.SHOP_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
  const check = (id) => active.length === 0 ? shop_defaults.includes(id) : active.includes(id);
  $("s-shops").innerHTML = shops.map((sh) => `<label><input type="checkbox" data-shop="${esc(sh.id)}"${check(sh.id) ? " checked" : ""}>${esc(sh.name)}</label>`).join("");
}

$("s-save-llm").onclick = async () => {
  try {
    await saveSetting("LLM_PROVIDER", $("s-provider").value);
    if ($("s-or-key").value) await saveSetting("OPENROUTER_API_KEY", $("s-or-key").value);
    await saveSetting("OPENROUTER_MODEL", $("s-or-model").value.trim() || "openai/gpt-4o-mini");
    $("s-or-key").value = "";
    $("s-llm-status").textContent = "Gespeichert.";
    loadSettings();
  } catch (err) { $("s-llm-status").textContent = "Fehler: " + err.message; }
};

$("s-test-llm").onclick = async () => {
  $("s-llm-status").textContent = "Teste …";
  try {
    const res = await fetch("/api/settings/test-openrouter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: $("s-or-key").value }),
    });
    const d = await res.json();
    $("s-llm-status").textContent = res.ok
      ? `Key ok (${d.models} Modelle verfügbar).` : "Fehler: " + (d.error || "unbekannt");
  } catch (err) { $("s-llm-status").textContent = "Fehler: " + err.message; }
};

$("s-save-shops").onclick = async () => {
  const ids = [...document.querySelectorAll("#s-shops input[data-shop]:checked")].map((c) => c.dataset.shop);
  await saveSetting("SHOP_IDS", ids.join(","));
  await saveSetting("SHOP_TIMEOUT_MS", $("s-timeout").value);
  loadSettings();
};

$("s-save-fb").onclick = async () => {
  await saveSetting("ENABLE_FALLBACK", $("s-fb").checked ? "true" : "false");
  if ($("s-brave-key").value) await saveSetting("BRAVE_API_KEY", $("s-brave-key").value);
  $("s-brave-key").value = "";
  loadSettings();
};

async function showDetail(id) {
  const res = await fetch("/api/history/" + id);
  const d = await res.json();
  const best = d.best
    ? `<p><span class="badge best">Bestpreis bisher: ${esc(d.best.display)} (${esc(d.best.at)})</span></p>` : "";
  $("detail").innerHTML = `<div class="card"><h3>${esc(d.query)}</h3>
    <p class="mut">Normalisiert: ${esc(d.normalized_query)} · ${esc(d.created_at)}</p>
    ${best}
    ${(d.results || []).map((p) => `<p><b>${esc((p.priceInfo && p.priceInfo.display) || p.price || "–")}</b>
    – <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>
    <span class="mut">(${esc(p.shopProviderName || "")})</span></p>`).join("")}
  </div>`;
  $("detail").classList.remove("hidden");
}
