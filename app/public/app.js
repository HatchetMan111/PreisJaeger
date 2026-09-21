"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

function switchTab(which) {
  $("tab-search").classList.toggle("active", which === "search");
  $("tab-history").classList.toggle("active", which === "history");
  $("view-search").classList.toggle("hidden", which !== "search");
  $("view-history").classList.toggle("hidden", which !== "history");
  if (which === "history") loadHistory();
}
$("tab-search").onclick = () => switchTab("search");
$("tab-history").onclick = () => switchTab("history");

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
