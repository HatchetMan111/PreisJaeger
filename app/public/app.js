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

let searchAbort = null;

$("search-form").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  $("stop").classList.remove("hidden");
  $("go").disabled = true;
  $("status").textContent = "Suche läuft (bis ~60 s) …";
  $("summary").classList.add("hidden");
  $("winner").classList.add("hidden");
  $("results").innerHTML = "";
  try {
    const res = await fetch("/api/search", {
      method: "POST",
      signal: searchAbort.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, price_min: $("pmin").value, price_max: $("pmax").value }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "Fehler");
    let status = `${d.results.length} Treffer in ${(d.duration_ms / 1000).toFixed(1)} s · Quelle: ${esc(d.source)}`;
    if (d.range && d.range.out_of_range) status += " · kein Treffer im Preisbereich";
    else if (d.range && d.range.out_count > 0) status += ` · ${d.range.out_count} außerhalb des Bereichs`;
    $("status").textContent = status;

    $("summary").innerHTML = `<div class="card">${esc(d.summary)}</div>`;
    $("summary").classList.remove("hidden");

    if (d.winner) {
      let bestHtml = "";
      if (d.is_new_best) {
        bestHtml = `<span class="badge best">Neuer Bestpreis!</span>`;
      }
      if (d.stats) {
        bestHtml += `<div class="mut">Tiefstpreis: <b>${esc(d.stats.low.display)}</b> (${esc(d.stats.low.at)}) · ` +
          `Höchstpreis: <b>${esc(d.stats.high.display)}</b> (${esc(d.stats.high.at)}) · aus ${d.stats.count} Suchen` +
          (d.best_confidence === "fuzzy" ? ` · <span class="mut">vermutlich gleiches Produkt</span>` : "") + `</div>`;
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
    if (err.name === "AbortError") {
      $("status").textContent = "Suche abgebrochen (Server-Lauf landet ggf. trotzdem im Verlauf).";
    } else {
      $("status").textContent = "Fehler: " + err.message;
    }
  } finally {
    searchAbort = null;
    $("stop").classList.add("hidden");
    $("go").disabled = false;
  }
};

$("stop").onclick = () => {
  if (searchAbort) searchAbort.abort();
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
  const sel = $("s-or-model");
  const savedModel = s.OPENROUTER_MODEL || "";
  if (savedModel && ![...sel.options].some((o) => o.value === savedModel)) {
    const opt = document.createElement("option");
    opt.value = savedModel;
    opt.textContent = savedModel + " (gespeichert)";
    sel.appendChild(opt);
  }
  sel.value = savedModel;
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

$("s-load-models").onclick = async () => {
  $("s-llm-status").textContent = "Lade Modelle …";
  try {
    const res = await fetch("/api/settings/openrouter-models");
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "unbekannt");
    const sel = $("s-or-model");
    const keep = sel.value;
    sel.innerHTML = "";
    for (const m of d.models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      sel.appendChild(opt);
    }
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
    $("s-llm-status").textContent = `${d.models.length} Modelle geladen – direkt wählen (tippen zum Springen).`;
  } catch (err) { $("s-llm-status").textContent = "Fehler: " + err.message; }
};

async function showDetail(id) {
  const res = await fetch("/api/history/" + id);
  const d = await res.json();
  const stats = d.stats
    ? `<p><span class="badge best">Tiefstpreis: ${esc(d.stats.low.display)} (${esc(d.stats.low.at)})</span> ` +
      `<span class="badge src">Höchstpreis: ${esc(d.stats.high.display)} (${esc(d.stats.high.at)})</span> ` +
      `<span class="mut">aus ${d.stats.count} Suchen</span></p>` : "";
  $("detail").innerHTML = `<div class="card"><h3>${esc(d.query)}</h3>
    <p class="mut">Normalisiert: ${esc(d.normalized_query)} · ${esc(d.created_at)}</p>
    ${stats}
    ${(d.results || []).map((p) => `<p><b>${esc((p.priceInfo && p.priceInfo.display) || p.price || "–")}</b>
    – <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>
    <span class="mut">(${esc(p.shopProviderName || "")})</span></p>`).join("")}
  </div>`;
  $("detail").classList.remove("hidden");
}
