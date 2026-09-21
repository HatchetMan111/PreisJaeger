#!/usr/bin/env bash
#
# PreisJaeger auf Proxmox LXC – Einzeiler-Installation (Community-Scripts-Stil)
#
#   bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/PreisJaeger/main/install/preisjaeger.sh)"
#
# Flags/Env: --ctid/--cores/--memory/--disk/--bridge/--storage/--port/--debug
#   CT_ID=101 CORES=2 RAM=2048 DISK=8 bash preisjaeger.sh
#   OPENROUTER_API_KEY=sk-or-... OPENROUTER_MODEL=openai/gpt-4o-mini bash preisjaeger.sh
#
set -Eeuo pipefail

# ---------------- Variablen (oben, anpassbar) ----------------
APP="preisjaeger"
HOSTNAME="preisjaeger"
REPO="https://github.com/HatchetMan111/PreisJaeger.git"
BRANCH="main"
PORT="${PORT:-8090}"
CORES="${CORES:-2}"
RAM="${RAM:-2048}"
DISK="${DISK:-8}"
BRIDGE="${BRIDGE:-vmbr0}"
STORAGE="${STORAGE:-}"          # leer = auto (local-lvm, Fallback local)
TEMPLATE_STORE="local"
CT_ID="${CT_ID:-}"              # leer = naechste freie ID
NODE_MAJOR="22"
DEBUG="${DEBUG:-0}"
# Optionale Keys (Host-Env -> Container-.env, gesetzte Werte nie ueberschrieben)
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
OPENROUTER_MODEL="${OPENROUTER_MODEL:-openai/gpt-4o-mini}"
LLM_PROVIDER="${LLM_PROVIDER:-none}"
BRAVE_API_KEY="${BRAVE_API_KEY:-}"

LOG="/tmp/${APP}-install-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

# ---------------- Fehlerkette (komplett, nie nur letzte Zeile) ----------------
fail() {
  local code=$? cmd="${BASH_COMMAND:-?}"
  echo ""
  echo "[FAIL] Installation abgebrochen."
  echo "  Befehl   : $cmd"
  echo "  Exit-Code: $code"
  echo "  Zeile    : ${BASH_LINENO[0]:-?} in ${FUNCNAME[1]:-main}"
  echo "  Stacktrace:"
  local i=0
  while caller $i 2>/dev/null; do i=$((i + 1)); done | sed 's/^/    /'
  if [[ -n "${CTID:-}" ]]; then
    echo "  --- pct config $CTID ---"
    pct config "$CTID" 2>&1 | sed 's/^/    /' || true
    echo "  --- pct status $CTID ---"
    pct status "$CTID" 2>&1 | sed 's/^/    /' || true
    echo "  --- journalctl -u $APP (letzte 100) ---"
    pct exec "$CTID" -- journalctl -u "$APP" --no-pager -n 100 2>&1 | sed 's/^/    /' || true
  fi
  echo "  Voll-Log : $LOG"
  echo "  Re-Run mit Trace: bash -x install/preisjaeger.sh --ctid ${CTID:-<id>}"
  exit "$code"
}
trap fail ERR

usage() {
  cat <<EOF
Verwendung: preisjaeger.sh [--ctid ID] [--cores N] [--memory MB] [--disk GB]
  [--bridge vmbr0] [--storage local-lvm] [--port 8090] [--debug] [--help]
Env-Alternativen: CT_ID, CORES, RAM, DISK, BRIDGE, STORAGE, PORT, DEBUG=1,
  OPENROUTER_API_KEY, OPENROUTER_MODEL, LLM_PROVIDER, BRAVE_API_KEY
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ctid) CT_ID="$2"; shift 2 ;;
    --cores) CORES="$2"; shift 2 ;;
    --memory) RAM="$2"; shift 2 ;;
    --disk) DISK="$2"; shift 2 ;;
    --bridge) BRIDGE="$2"; shift 2 ;;
    --storage) STORAGE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --debug) DEBUG=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unbekannte Option: $1"; usage; exit 2 ;;
  esac
done
[[ "$DEBUG" == "1" ]] && set -x

ok() { echo "[OK]    $*"; }
step() { echo "==> $*"; }

# ---------------- 1. Host-Pruefung ----------------
step "Pruefe Host und Werkzeuge"
[[ "$(id -u)" -eq 0 ]] || { echo "Bitte als root auf dem Proxmox-Host ausfuehren."; exit 1; }
for bin in pct pvesh wget openssl; do
  command -v "$bin" >/dev/null || { echo "Fehlt auf dem Host: $bin"; exit 1; }
done
ok "Host ok (root, pct/pvesh/wget/openssl vorhanden)."

# ---------------- 2. CT-ID ----------------
if [[ -z "$CT_ID" ]]; then
  CT_ID="$(pvesh get /cluster/nextid)"
fi
CTID="$CT_ID"
ok "CT-ID: $CTID"

# ---------------- 3. Storage ----------------
if [[ -z "$STORAGE" ]]; then
  if pvesh get /storage/local-lvm --output-format json >/dev/null 2>&1; then
    STORAGE="local-lvm"
  else
    STORAGE="local"
  fi
fi
ok "RootFS-Storage: $STORAGE"

# ---------------- 4. Template ----------------
step "Pruefe debian-12-Standard-Template auf '$TEMPLATE_STORE'"
TPL_HAVE="$(pveam list "$TEMPLATE_STORE" 2>/dev/null | awk '/debian-12-standard/ {print $1}' | sort -V | tail -1 || true)"
if [[ -z "$TPL_HAVE" ]]; then
  step "Lade neuestes debian-12-Standard-Template"
  pveam update
  TPL_AVAIL="$(pveam available --section system 2>/dev/null | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1)"
  [[ -n "$TPL_AVAIL" ]] || { echo "Kein debian-12-Template verfuegbar."; exit 1; }
  pveam download "$TEMPLATE_STORE" "$TPL_AVAIL"
  TPL_HAVE="$(pveam list "$TEMPLATE_STORE" 2>/dev/null | awk '/debian-12-standard/ {print $1}' | sort -V | tail -1)"
fi
[[ -n "$TPL_HAVE" ]] || { echo "Template-Auswahl fehlgeschlagen."; exit 1; }
ok "Template: $TPL_HAVE"

# ---------------- 5. Container erstellen (oder Update-Pfad) ----------------
NEW_CT=0
if pct status "$CTID" >/dev/null 2>&1; then
  step "CT $CTID existiert bereits -> Update-Pfad (idempotent, keine Datenverluste)"
else
  step "Erstelle LXC $CTID ($HOSTNAME, $CORES vCPU / $RAM MB / ${DISK}G)"
  ROOT_PW="$(openssl rand -base64 12)"
  pct create "$CTID" "$TPL_HAVE" \
    --hostname "$HOSTNAME" --cores "$CORES" --memory "$RAM" \
    --rootfs "$STORAGE:$DISK" \
    --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
    --onboot 1 --unprivileged 1 --features nesting=1 \
    --password "$ROOT_PW" --start 1
  NEW_CT=1
  ok "Container erstellt und gestartet."
fi

step "Warte auf Boot + Netzwerk"
for i in $(seq 1 30); do
  sleep 5
  LXC_IP="$(pct exec "$CTID" -- ip -4 -o addr show eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1 || true)"
  if [[ -n "${LXC_IP:-}" ]]; then break; fi
done
[[ -n "${LXC_IP:-}" ]] || { echo "Keine Container-IP erhalten."; exit 1; }
ok "Container-IP: $LXC_IP"

# ---------------- 6. Setup-Dateien in den Container schieben ----------------
step "Uebertrage Setup-Script in den Container"
SETUP_LOCAL="$(mktemp)"
ENV_LOCAL="$(mktemp)"
chmod 600 "$ENV_LOCAL"
cat > "$ENV_LOCAL" <<EOF
PORT=$PORT
OPENROUTER_API_KEY=$OPENROUTER_API_KEY
OPENROUTER_MODEL=$OPENROUTER_MODEL
LLM_PROVIDER=$LLM_PROVIDER
BRAVE_API_KEY=$BRAVE_API_KEY
EOF

# Hinweis: bewusst quoted heredoc (keine Expansion auf dem Host).
cat > "$SETUP_LOCAL" <<'SETUP_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
APP="preisjaeger"
PORT_IN="${1:?PORT fehlt}"
ENV_FILE="/tmp/preisjaeger-env"
# shellcheck disable=SC1090
source "$ENV_FILE"

echo "==> [CT] Systempakete"
export DEBIAN_FRONTEND=noninteractive
export LANG=C LC_ALL=C   # stumme perl/locale-Warnungen im Debian-Template
apt-get update
apt-get install -y curl ca-certificates gnupg git python3 build-essential iproute2 openssl

echo "==> [CT] Node.js 22 (NodeSource, idempotent)"
if ! command -v node >/dev/null || ! node -v | grep -q '^v22\.'; then
  curl -fsSL "https://deb.nodesource.com/setup_22.x" | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> [CT] User $APP"
id "$APP" >/dev/null 2>&1 || useradd -r -m -d "/opt/$APP" -s /bin/bash "$APP"
mkdir -p "/opt/$APP/data"
chown -R "$APP:$APP" "/opt/$APP"

echo "==> [CT] App-Code (Klon oder Update, nur bei neuer Rev neu bauen)"
cd "/opt/$APP"
git config --global --add safe.directory "/opt/$APP/repo" 2>/dev/null || true
NEED_BUILD=0
if [[ -d repo/.git ]]; then
  OLD_REV="$(git -C repo rev-parse HEAD)"
  git -C repo fetch origin
  git -C repo reset --hard "origin/main"
  NEW_REV="$(git -C repo rev-parse HEAD)"
  [[ "$OLD_REV" != "$NEW_REV" ]] && NEED_BUILD=1
else
  rm -rf repo app repo-tmp
  git clone --branch main --depth 1 "https://github.com/HatchetMan111/PreisJaeger.git" repo-tmp
  mv repo-tmp repo
  NEED_BUILD=1
fi
# Repo-Root != App-Root: die Node-App liegt in repo/app -> als app/ verlinken
ln -sfn "/opt/$APP/repo/app" app
chown -R "$APP:$APP" "/opt/$APP"

echo "==> [CT] npm-Abhaengigkeiten (Diagnose: App-Inhalt)"
ls -la app | head -25
if [[ "$NEED_BUILD" == "1" || ! -d app/node_modules ]]; then
  if [[ -f app/package-lock.json ]]; then
    (cd app && npm ci --omit=dev --no-audit --no-fund)
  else
    echo "[CT] WARNUNG: kein package-lock.json im Klon -> Fallback 'npm install'"
    (cd app && npm install --omit=dev --no-audit --no-fund)
  fi
  chown -R "$APP:$APP" "/opt/$APP"
fi

echo "==> [CT] Playwright-Chromium passend zur installierten Playwright-Version"
# WICHTIG: Browser muessen zur TATSAECHLICH installierten Playwright-Version passen,
# sonst liefert die Suche still 'No results' (gelernt aus Live-Test).
(cd app && npx --no-install playwright install --with-deps chromium)

echo "==> [CT] .env (nur leere Werte fuellen, gesetzte nie ueberschreiben)"
fill_empty() { # key value envfile
  local key="$1" val="$2" file="$3"
  if [[ -z "$val" ]]; then return 0; fi
  if grep -q "^${key}=$" "$file" 2>/dev/null; then
    python3 - "$key" "$val" "$file" <<'PYEOF'
import sys
key, val, path = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().splitlines(keepends=True)
with open(path, "w") as f:
    for line in lines:
        f.write((key + "=" + val + "\n") if line.strip() == key + "=" else line)
PYEOF
  fi
}
[[ -f /opt/$APP/.env ]] || cp "app/.env.example" "/opt/$APP/.env"
set +x  # Secrets duerfen nie ins -x-Log
fill_empty PORT "$PORT_IN" "/opt/$APP/.env"
fill_empty OPENROUTER_API_KEY "$OPENROUTER_API_KEY" "/opt/$APP/.env"
fill_empty OPENROUTER_MODEL "$OPENROUTER_MODEL" "/opt/$APP/.env"
fill_empty LLM_PROVIDER "$LLM_PROVIDER" "/opt/$APP/.env"
fill_empty BRAVE_API_KEY "$BRAVE_API_KEY" "/opt/$APP/.env"
[[ "$DEBUG" == "1" ]] && set -x
chown "$APP:$APP" "/opt/$APP/.env"
chmod 600 "/opt/$APP/.env"

echo "==> [CT] systemd-Unit"
cp "repo/systemd/preisjaeger.service" /etc/systemd/system/preisjaeger.service
systemctl daemon-reload
systemctl enable preisjaeger
systemctl restart preisjaeger || systemctl start preisjaeger

echo "==> [CT] Firewall"
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT_IN"/tcp
fi

rm -f "$ENV_FILE"
echo "[CT] Setup fertig."
SETUP_EOF

pct push "$CTID" "$SETUP_LOCAL" /tmp/preisjaeger-setup.sh
pct push "$CTID" "$ENV_LOCAL" /tmp/preisjaeger-env
shred -u "$ENV_LOCAL" 2>/dev/null || rm -f "$ENV_LOCAL"
rm -f "$SETUP_LOCAL"

step "Fuehre Setup im Container aus"
pct exec "$CTID" -- bash /tmp/preisjaeger-setup.sh "$PORT"
pct exec "$CTID" -- rm -f /tmp/preisjaeger-setup.sh
ok "Setup im Container abgeschlossen."

# ---------------- 7. Verifikation ----------------
step "Verifiziere Service + Web UI"
pct exec "$CTID" -- systemctl is-active preisjaeger
ok "Service laeuft (systemctl is-active preisjaeger = active)."
for i in $(seq 1 45); do
  if pct exec "$CTID" -- curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
  [[ "$i" == "45" ]] && { echo "Web UI antwortet nicht auf Port $PORT."; exit 1; }
done
ok "Web UI antwortet (HTTP-Check auf localhost:$PORT/api/health)."

echo ""
echo "================ INSTALLATION ERFOLGREICH ================"
echo "  App          : PreisJaeger - lokale Preisrecherche"
echo "  Container    : CT $CTID (Hostname: $HOSTNAME, onboot=1)"
echo "  Ressourcen   : $CORES vCPU / $RAM MB RAM / ${DISK} GB Disk"
echo "  Web UI       : http://$LXC_IP:$PORT"
echo "  Health       : http://$LXC_IP:$PORT/api/health"
if [[ "$NEW_CT" == "1" ]]; then
echo "  Root-Passwort: $ROOT_PW (nur jetzt angezeigt - sicher ablegen!)"
fi
echo "  Service      : systemctl status preisjaeger  (im Container via: pct enter $CTID)"
echo "  Update       : Skript erneut laufen lassen: bash preisjaeger.sh --ctid $CTID"
echo "  Deinstall    : pct stop $CTID && pct destroy $CTID"
echo "  Reboot-Test  : pct reboot $CTID && sleep 30 && curl -fs http://$LXC_IP:$PORT/api/health"
echo "  Log          : $LOG"
echo "=========================================================="
