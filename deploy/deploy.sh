#!/usr/bin/env bash
# Ship the current build to the spacescience origin.
#
# Routine deploys copy two files and nothing else: no image rebuild, no
# restart, no downtime. The container mounts the site directory read-only, so
# nginx picks up whatever is there on the next request.
#
#   SS_HOST=user@host ./deploy/deploy.sh            # deploy
#   SS_HOST=user@host SS_NETWORK=net ./deploy/deploy.sh --setup   # first run
#
# The host is not baked in on purpose -- this repo is public.
set -euo pipefail

HOST="${SS_HOST:-}"
if [[ -z "$HOST" ]]; then
  echo "SS_HOST is not set. Example: SS_HOST=balsa@100.81.51.125 $0" >&2
  exit 2
fi

REMOTE_DIR="apps/spacescience"
# The podman network the tunnel connector sits on. Host-specific, so it is not
# committed; only needed for --setup.
NETWORK="${SS_NETWORK:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETUP=0
[[ "${1:-}" == "--setup" ]] && SETUP=1

echo "==> building"
node "$ROOT/build.mjs"

SRC="$ROOT/dist/index.html"
[[ -f "$SRC" ]] || { echo "no dist/index.html" >&2; exit 1; }

# Pre-compress once here rather than making nginx do it per request: the page
# is mostly base64 audio, and gzip mainly wins back base64's own overhead.
echo "==> compressing"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$SRC" "$TMP/index.html"
gzip -9 -k -f "$TMP/index.html"
printf '     raw %s  gz %s\n' \
  "$(du -h "$TMP/index.html" | cut -f1)" "$(du -h "$TMP/index.html.gz" | cut -f1)"

echo "==> uploading to $HOST:$REMOTE_DIR"
ssh "$HOST" "mkdir -p ~/$REMOTE_DIR/site"
scp -q "$TMP/index.html"    "$HOST:$REMOTE_DIR/site/.index.html.new"
scp -q "$TMP/index.html.gz" "$HOST:$REMOTE_DIR/site/.index.html.gz.new"

if [[ $SETUP -eq 1 ]]; then
  if [[ -z "$NETWORK" ]]; then
    echo "SS_NETWORK is not set (the podman network the tunnel connector uses)" >&2
    exit 2
  fi
  echo "==> installing config and unit (network: $NETWORK)"
  scp -q "$ROOT/deploy/nginx.conf" "$HOST:$REMOTE_DIR/nginx.conf"
  sed "s|@@NETWORK@@|${NETWORK}|" "$ROOT/deploy/spacescience.container" \
    | ssh "$HOST" "cat > .config/containers/systemd/spacescience.container"
fi

echo "==> swapping in"
# mv is atomic within a filesystem, so a request can never see a half-written
# page -- it gets the old one or the new one.
ssh "$HOST" "
  set -e
  cd ~/$REMOTE_DIR/site
  mv -f .index.html.new    index.html
  mv -f .index.html.gz.new index.html.gz
  chmod 0644 index.html index.html.gz
"

if [[ $SETUP -eq 1 ]]; then
  echo "==> starting service"
  ssh "$HOST" "
    set -e
    systemctl --user daemon-reload
    systemctl --user start spacescience.service
    sleep 3
    systemctl --user is-active spacescience.service
  "
fi

echo "==> verifying origin"
ssh "$HOST" "
  set -e
  curl -fsS http://127.0.0.1:18082/healthz >/dev/null && echo '    healthz ok'
  code=\$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18082/)
  size=\$(curl -sS -o /dev/null -w '%{size_download}' http://127.0.0.1:18082/)
  echo \"    GET / -> \$code, \$size bytes\"
  gz=\$(curl -sS -H 'Accept-Encoding: gzip' -o /dev/null \
        -w '%{size_download}' http://127.0.0.1:18082/)
  echo \"    GET / (gzip) -> \$gz bytes\"
  [ \"\$code\" = 200 ]
"
echo "==> done"
