# PreisJäger auf Proxmox LXC – Einzeiler-Installation

> **Hinweis:** Anders als bei den reinen Installer-Repos liegt hier **alles in einem Repo**:
> App-Code (`app/`), Proxmox-Installer (`install/preisjaeger.sh`) und
> systemd-Unit (`systemd/preisjaeger.service`).

PreisJäger ist eine **vollständig lokale** Preisrecherche: Produkt eingeben →
Preissieger über mehrere Shops (Amazon, eBay, Dealabs/mydealz u. a.) →
**jede Anfrage** landet in einer Verlaufstabelle, dazu wird der
**historische Bestpreis** („für welches Geld war das Produkt einmal zu bekommen?")
angezeigt. LLM (OpenRouter) und Fallback-Suche (Brave) sind **optional** –
ohne Keys läuft die Kernfunktion deterministisch und ohne Cloud.

| Eigenschaft | Wert |
|---|---|
| App-Name / Hostname | `preisjaeger` |
| Tech-Stack | Node.js 22 + Express + SQLite + Playwright (`mcp-shop-server` als Library) |
| Web UI | `http://<LXC-IP>:8090` (bind `0.0.0.0:8090`) |
| Health | `http://<LXC-IP>:8090/api/health` |
| Standard-Ressourcen | 2 vCPU / 2048 MB RAM / 8 GB Disk |
| CT-ID | immer die **nächste freie ID** (`pvesh get /cluster/nextid`), außer `--ctid` gesetzt |
| Template | `debian-12-standard` (neuestes auf Storage `local`) |

## 1. Installation (Einzeiler, auf dem Proxmox-Host als root)

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/PreisJaeger/main/install/preisjaeger.sh)"
```

Anpassungen per Umgebungsvariable oder Flag:

```bash
CT_ID=101 CORES=2 RAM=2048 DISK=8 bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/PreisJaeger/main/install/preisjaeger.sh)"
bash preisjaeger.sh --ctid 101 --cores 2 --memory 2048 --disk 8 --bridge vmbr0 --storage local-lvm --port 8090
bash preisjaeger.sh --debug   # = bash -x, maximale Fehlermeldungskette
```

Optionale Keys (werden in die Container-`.env` übernommen, gesetzte Werte nie überschrieben):

```bash
OPENROUTER_API_KEY=sk-or-... OPENROUTER_MODEL=openai/gpt-4o-mini LLM_PROVIDER=openrouter bash preisjaeger.sh --ctid 101
BRAVE_API_KEY=... bash preisjaeger.sh --ctid 101   # Fallback bei 0 Shop-Treffern
```

Das Skript (`set -euo pipefail`, idempotent):
1. prüft Host/Tools, nimmt die nächste freie CT-ID,
2. erkennt RootFS-Storage (bevorzugt `local-lvm`), lädt das neueste
   `debian-12-standard`-Template falls nötig,
3. erstellt den LXC `preisjaeger` (`onboot: 1`, unprivilegiert, `nesting=1`),
4. installiert im Container Node.js 22, Build-Tools, klont dieses Repo nach
   `/opt/preisjaeger/repo` (User `preisjaeger`; `app/` ist ein Symlink auf
   `repo/app`, da Repo-Root != App-Root), `npm ci --omit=dev`,
5. installiert **danach** den Chromium passend zur tatsächlich installierten
   Playwright-Version (sonst liefert die Suche still keine Ergebnisse),
6. schreibt `/opt/preisjaeger/.env` (nur leere Werte), installiert die
   systemd-Unit, `systemctl enable --now`,
7. verifiziert `systemctl is-active preisjaeger` + HTTP-Check auf
   `localhost:8090/api/health` und gibt die finale URL aus.

Erwartete Schlussausgabe (Beispiel):

```text
[OK]    Service läuft (systemctl is-active preisjaeger = active).
[OK]    Web UI antwortet (HTTP-Check auf localhost:8090/api/health).

================ INSTALLATION ERFOLGREICH ================
  App          : PreisJaeger - lokale Preisrecherche
  Container    : CT 100 (Hostname: preisjaeger, onboot=1)
  Ressourcen   : 2 vCPU / 2048 MB RAM / 8 GB Disk
  Web UI       : http://192.168.1.100:8090
  Health       : http://192.168.1.100:8090/api/health
  Root-Passwort: aB3... (nur jetzt angezeigt – sicher ablegen!)
  Service      : systemctl status preisjaeger  (im Container via: pct enter 100)
  Update       : Skript erneut laufen lassen: bash preisjaeger.sh --ctid 100
  Deinstall    : pct stop 100 && pct destroy 100
  Reboot-Test  : pct reboot 100 && sleep 30 && curl -fs http://192.168.1.100:8090/api/health
  Log          : /tmp/preisjaeger-install-2026-....log
==========================================================
```

## 2. Benutzung

1. Browser: `http://<LXC-IP>:8090` → Produkt suchen (z. B. „Ubiquiti UXG-Lite").
   Läuft **ohne Keys** (lokal, regelbasiert).
2. Ergebnis: Preissieger-Badge, alle Treffer mit Preis/Shop/Link, Zusammenfassung.
3. **Bestpreis-Box**: „Bestpreis bisher: X € (Datum)" oder „Neuer Bestpreis!".
   Matching per ASIN (exakt) bzw. Produktname („vermutlich gleiches Produkt").
4. Reiter **Verlauf**: alle Anfragen als Tabelle, Klick → Detail, Export als CSV/JSON.
5. Hinweis: `amazon.com`-Treffer sind USA-Import (ggf. Versand + Zoll).
6. Reiter **Einstellungen**: OpenRouter-Key + Modell (+ Key-Test-Button),
   Shop-Auswahl, Timeout, Brave-Fallback – alles ohne Neustart, Keys werden
   maskiert angezeigt und nur in der Container-DB gespeichert.

## 3. Reboot-Test (Reboot-sicher belegen)

```bash
CT=100
pct reboot $CT
sleep 30
pct exec $CT -- systemctl is-active preisjaeger   # muss: active
curl -fs http://$(pct exec $CT -- ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1):8090/api/health
pct config $CT | grep -i onboot                   # muss: onboot: 1
```

## 4. Update (idempotent – einfach erneut laufen lassen)

```bash
bash preisjaeger.sh --ctid 100
# pullt Branch 'main' (reset --hard), npm ci nur bei neuer Rev,
# Chromium-Sync + systemctl restart.
```

## 5. Deinstallation

```bash
pct stop 100 && pct destroy 100
```

## 6. Debugging (komplette Fehlermeldungskette)

- Jeder Lauf loggt **stdout+stderr vollständig** nach `/tmp/preisjaeger-install-<Datum>.log`.
- Bei Fehlern druckt das Skript: Befehl, Exit-Code, Zeile, Stacktrace (`caller`),
  `pct config`/`pct status`, `journalctl -u preisjaeger -n 100` – niemals nur die letzte Zeile.
- Re-run mit Trace (`--debug` maskiert Secrets beim `.env`-Schreiben automatisch):

```bash
bash -x preisjaeger.sh --ctid 100
tail -n 200 /tmp/preisjaeger-install-*.log
pct exec 100 -- journalctl -u preisjaeger --no-pager -n 100
```

## 7. Dateien in diesem Repo

```text
PreisJaeger/
├── install/preisjaeger.sh       # Proxmox-Install-Script (Variablen oben, idempotent)
├── systemd/preisjaeger.service  # systemd-Unit (Restart=always, After=network-online.target)
├── app/                         # App-Code
│   ├── server.js                # Express: /api/health, /api/search, /api/history, /api/shops
│   ├── lib/db.js                # SQLite: searches-Tabelle, Bestpreis-Query
│   ├── lib/config.js            # Einstellungen (DB schlägt .env, kein Neustart nötig)
│   ├── lib/shops.js             # mcp-shop-server als Library, EUR-Parsing, Preissieger, Produkt-Key
│   ├── lib/llm.js               # LLM-Abstraktion: none (Standard) oder openrouter
│   ├── lib/fallback.js          # Brave-Fallback bei 0 Treffern (opt-in)
│   ├── public/                  # Web UI (Suche + Verlauf, deutsch)
│   ├── package.json
│   └── .env.example
└── README.md                    # diese Datei
```

## 8. Hinweise

- **Warum LXC statt VM:** Node + headless Chromium laufen unprivilegiert im LXC;
  kein Docker, kein GPU-Bedarf. VM nur nötig, falls lokal ein großes LLM
  (Ollama) daneben laufen soll.
- **Playwright-Versionierung (wichtig):** `mcp-shop-server` löst
  `playwright: ^1.54.1` auf die neueste 1.x auf. Der Installer installiert den
  Chromium **nach** `npm ci` aus der App-Umgebung (`npx --no-install playwright`),
  damit Browser-Build und Playwright-Version zusammenpassen – sonst liefert
  die Suche still `No results`.
- **Browser-Pfad:** Chromium liegt in `/opt/preisjaeger/ms-playwright`
  (per `PLAYWRIGHT_BROWSERS_PATH` in der Unit), damit der Service-User
  `preisjaeger` ihn findet – `/root/.cache` wäre für ihn unsichtbar.
- **RAM:** 2 GB Standard für paralleles Scraping mehrerer Shops; per
  `--memory 4096` erhöhbar. Per `SHOP_IDS` in der `.env` lässt sich die
  Shop-Auswahl begrenzen (weniger parallele Browser-Kontexte).
- **DHCP-Hinweis:** Ändert sich die Container-IP, Bookmarks anpassen oder
  DHCP-Reservierung/statische IP einrichten.
- **Bekannte Einschränkung V1:** reiner Preisvergleich – günstiges Zubehör
  (z. B. Wandhalterung statt Gerät) kann als Preissieger gewinnen. Roadmap:
  Relevanz-Scoring (Titel-Match) + Preisalarm.
- **Rechtliches:** nur lesende Recherche, kein Kauf; Shop-ToS beachten.
- **Roadmap:** Firecrawl als zweite Fallback-Stufe, EAN-Matching, Preisalarm.
