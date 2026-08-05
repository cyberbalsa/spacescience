# Deployment

SPACE SCIENCE is a single static file, so the origin is deliberately boring: an
nginx container that serves one page and redirects everything else to it.

## Layout

```
        Cloudflare
            |
        (tunnel: cloudflared)
            |
   podman network
   ┌────────┼──────────────────────────────┐
   │        v                              │
   │   spacescience:8080   <- this repo    │
   │   ...other services on the same host  │
   └───────────────────────────────────────┘
```

The origin is **its own container on purpose**. The host runs other services
behind the same tunnel, and a 10 MB page has no business being served out of
one of their app processes — nor should a deploy here be able to take any of
them down. Nothing in this repo touches anything else on the host.

On the host:

```
~/apps/spacescience/nginx.conf          origin config
~/apps/spacescience/site/index.html     the game
~/apps/spacescience/site/index.html.gz  pre-compressed, served by gzip_static
~/.config/containers/systemd/spacescience.container   quadlet unit
```

Diagnostic origin: `http://127.0.0.1:18082` (loopback only, like the others).

## Deploying a new version

```sh
SS_HOST=user@host ./deploy/deploy.sh
```

That builds, compresses, uploads, and replaces each file atomically. **No image
rebuild, no restart, no downtime** — nginx mounts the site directory read-only
and picks up whatever is there on the next request. Each swap is a `mv` within
one filesystem, so a request can never see a half-written file. The raw and
gzip files are separate moves, leaving a tiny mixed-version window between
them; do not run concurrent deploys. The script retains both previous files as
`.prev`, checks both uploaded hashes, and tests gzip integrity before succeeding.

The host is not baked into the script, because this repo is public. Set
`SS_HOST` (for example in your shell profile) or pass it inline.

## First-time setup on a new host

```sh
SS_HOST=user@host SS_NETWORK=<podman-network> ./deploy/deploy.sh --setup
```

Additionally installs `nginx.conf` and the quadlet, runs `daemon-reload`, and
starts the service. `SS_NETWORK` must name the existing podman network the
tunnel connector is attached to — it is host-specific, so it is not committed.
The user also needs lingering enabled (`loginctl enable-linger`), which is what
lets a rootless unit start at boot without a login.

After `--setup` the origin is live on loopback but **the public domain is
not pointed at it yet** — see below.

## Pointing spacescience.tech at it

**Done** — the tunnel now routes `spacescience.tech` and `*.spacescience.tech`
to `http://spacescience:8080`. Config version 5 → 6. This section is kept for
how it works and how to undo it.

### It cannot be done from the host

The tunnel is **remotely managed**: its ingress lives in Cloudflare and
`cloudflared` refetches it on every connect. Converting the connector to a
local `config.yml` — credentials file derived from the tunnel token, all 31
rules reproduced, `cloudflared tunnel ingress validate` passing, `tunnel
ingress rule` matching correctly — does *not* work. On restart it logs

```
INF Updated to new configuration config="{\"ingress\":[ ... ]}"
```

and the remote config wins. There is no flag to prefer the local file. Only the
Cloudflare API or dashboard can move a route.

### Changing a route

Needs a token with **Account → Cloudflare Tunnel → Edit**. Read the live
config, change only what you mean to, and PUT it back — the endpoint replaces
the whole ingress, so a partial payload silently drops every other hostname:

```sh
ACCT=<account tag>; TUN=<tunnel id>
curl -sS "https://api.cloudflare.com/client/v4/accounts/$ACCT/cfd_tunnel/$TUN/configurations" \
  -H "Authorization: Bearer $CF_API_TOKEN" > live.json

# edit only the rules you intend to, then diff before sending
curl -sS -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/cfd_tunnel/$TUN/configurations" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  --data @new.json
```

Two things worth asserting before the PUT, because the blast radius is every
hostname on the tunnel: that exactly the intended rules changed, and that the
`http_status:404` catch-all is still last.

The connector picks the new config up within seconds; no restart needed.

### Rolling back

The pre-change config is on the server at
`~/apps/tunnel-config-v5-before-spacescience.json` (not in this repo — it maps
every hostname to its internal service name). Wrap its `result.config` in
`{"config": ...}` and PUT it back to return `spacescience.tech` to the parked
page.

## Checks

```sh
systemctl --user --no-pager --full status spacescience.service
podman ps --filter name=spacescience
podman healthcheck run spacescience
podman logs --tail 100 spacescience

curl -fsS http://127.0.0.1:18082/healthz
curl -sS -o /dev/null -w '%{http_code} %{size_download}\n' http://127.0.0.1:18082/
curl -sS -o /dev/null -D- http://127.0.0.1:18082/nope | grep -i location
curl -sS -H 'Accept-Encoding: gzip' -o /dev/null -D- \
  http://127.0.0.1:18082/ | grep -i content-encoding
```

Expected: `healthz` 200, `/` 200 at ~10.7 MB, `/nope` a 302 with a relative
`Location: /`, and `Content-Encoding: gzip` on the compressed request.

### Everything goes home

There is no 404 on this origin. Unknown paths are caught by the catch-all
location, and anything that still manages to produce an error status (403, 404,
405, 414) is routed to a named location that redirects as well, so a visitor
never sees an nginx error page:

```
/                          200
/nope                      302 -> /
/deep/nested/path          302 -> /
/wp-admin/setup-config.php 302 -> /
/.env                      302 -> /
DELETE /                   302 -> /
/healthz                   200
```

One subtlety worth keeping: `location = /` uses `try_files /index.html =503`,
**not** `=404`. With `=404` a missing page would be sent to the redirect
handler, which points at `/`, which would 404 again — an infinite redirect
loop. A missing page is a server fault, so it reports one.

## Rolling back the page

The deploy script keeps the immediately previous raw and gzip files. Restore
them as a pair so compressed clients do not continue receiving the newer build:

```sh
ssh "$SS_HOST" 'cd ~/apps/spacescience/site && \
  cp -f index.html.prev index.html && \
  cp -f index.html.gz.prev index.html.gz'
```

Rolling back the *container* is a normal systemd operation; the image is stock
`nginx:1.30.4-alpine` and holds no application state.

## Why it is built this way

- **Pre-compressed, not `gzip on`.** The page is ~10.7 MB and almost entirely
  base64 audio. Compressing per request would burn CPU for a modest win, so the
  deploy ships a `.gz` and `gzip_static` hands it over: 10.7 MB → 7.6 MB at zero
  runtime cost.
- **Read-only rootfs, all capabilities dropped, uid 1000.** Matching the other
  units on the host. Everything nginx writes — pid, temp paths — is redirected
  under a small `tmpfs`.
- **One page, one path.** Any other path 302s home, which is how the other
  parked apexes on this host already behave.

## Analytics note

The Cloudflare Web Analytics beacon only reports over `http(s)`. Opened from
`file://` it disables itself, so numbers exist only once the domain is pointed
here. See the README for what is and is not collected.
