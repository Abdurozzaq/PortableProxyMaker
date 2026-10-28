#!/usr/bin/env bash
# One-shot installer for Ubuntu Server: installs Docker (if missing), creates .env,
# opens the firewall and starts PortableProxyMaker.
set -euo pipefail

cd "$(dirname "$0")/.."

# Git Bash / MSYS2 / Cygwin on Windows: hand over to the PowerShell installer.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$PWD/scripts/install.ps1")" "$@"
    ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash scripts/install.sh"
  exit 1
fi

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

if ! docker compose version >/dev/null 2>&1; then
  say "Installing docker compose plugin"
  apt-get update -y && apt-get install -y docker-compose-plugin
fi

if [ ! -f .env ]; then
  say "Creating .env"
  cp .env.example .env
  PUBLIC_IP="$(curl -fsS4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"
  ADMIN_PW="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)"
  sed -i "s|^PUBLIC_HOST=.*|PUBLIC_HOST=${PUBLIC_IP}|" .env
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${ADMIN_PW}|" .env
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

mkdir -p data

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  say "Opening firewall (ufw): panel ${PANEL_PORT} + proxy range ${PROXY_PORT_MIN}:${PROXY_PORT_MAX}"
  ufw allow "${PANEL_PORT}/tcp"
  ufw allow "${PROXY_PORT_MIN}:${PROXY_PORT_MAX}/tcp"
fi

say "Building and starting container"
docker compose up -d --build

say "Done"
echo "Panel : http://${PUBLIC_HOST:-<server-ip>}:${PANEL_PORT}"
echo "Login : ${ADMIN_USER} / ${ADMIN_PASSWORD:-(see data/admin_password.txt)}"
echo "Logs  : docker compose logs -f"
echo
echo "If your cloud provider has its own firewall / security group, also allow TCP ${PANEL_PORT} and ${PROXY_PORT_MIN}-${PROXY_PORT_MAX}."
