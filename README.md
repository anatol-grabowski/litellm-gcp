# LiteLLM on Google Cloud Compute Engine

Low-cost, reliable deployment of the [LiteLLM proxy](https://docs.litellm.ai/) on a
single GCE VM: `e2-small`, Container-Optimized OS, an on-VM Postgres container
for budgets/keys/spend tracking, no managed database service, no load
balancer. Everything is driven by three local `.env` files (created from tracked `.example` templates) and a single `deploy.sh`.

## Layout

| File | Purpose |
|---|---|
| `.env.gcp.example` | Tracked template for GCP-side settings — project, zone, machine type, firewall, image tags |
| `.env.litellm.example` | Tracked template for LiteLLM runtime settings — master key, salt key, provider API keys |
| `.env.db.example` | Tracked template for Postgres credentials |
| `.env.gcp`, `.env.litellm`, `.env.db` | Local deployment files created from the templates; ignored by git |
| `config/config.yaml` | LiteLLM model list |
| `scripts/deploy.sh` | Idempotent create/update |
| `scripts/startup-script.sh` | Runs on the VM itself on every boot; pulls both images and (re)starts the Postgres + LiteLLM containers |
| `scripts/teardown.sh` | Deletes the instance and firewall rules |

## Why Postgres is now included

`/ui` login, virtual (non-master) API keys, and per-user/per-key/per-team
**budgets** all read and write the same Postgres-backed tables — none of them
work against the master key alone. Rather than add a managed Cloud SQL
instance (~$8–10/mo minimum), this runs Postgres as a second container on the
same VM, on a private Docker network, with its data on the boot disk. That's
the minimum needed to make budgets functional; it's less durable than Cloud
SQL (see trade-offs below), and it's why `MACHINE_TYPE` moved from `e2-micro`
to `e2-small` — a single 1GB instance isn't reliably enough headroom for both
containers.

## Why this design

- **Cheapest**: `e2-micro` + `pd-standard` 10GB disk are the lowest-cost GCE
  building blocks, and both are free-tier eligible in `us-central1`,
  `us-east1`, `us-west1` (1 instance-month + 30GB disk, per billing account).
  No Cloud SQL, no Redis, no load balancer, no reserved static IP.
- **Simplest / most reliable**: Google deprecated the old
  `create-with-container` / `update-container` declarative flow. This uses
  the currently recommended pattern instead — a plain Container-Optimized OS
  image with a `docker run` startup script. The script re-runs on every boot
  and reconciles the container to match the current image/config/env, which
  is what makes the whole thing idempotent by construction, not just the
  deploy script around it.
- **Idempotent end-to-end**: re-running `deploy.sh` never duplicates
  resources. APIs/firewall rules are created only if missing; the instance is
  created if absent, or has its metadata updated and rebooted if present.

## Prerequisites

- `gcloud` CLI installed and authenticated: `gcloud auth login`
- A GCP project with billing enabled
- `openssl` (used once, locally, to generate the master key)

## 1. Configure

If upgrading an older checkout that still has `.env.prod`, keep your existing
VM settings by renaming that local file first:

```bash
mv .env.prod .env.gcp
```

For a fresh checkout, create the local, git-ignored environment files once:

```bash
cp .env.gcp.example .env.gcp
cp .env.litellm.example .env.litellm
cp .env.db.example .env.db
```

Edit `.env.gcp`:
- Set `PROJECT_ID` (or leave blank to use your current `gcloud` default project)
- Adjust `ZONE`/`REGION` if needed
- Change `LITELLM_IMAGE` whenever you want to deploy another LiteLLM version

Edit `.env.litellm`:
- Fill in `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` for whichever providers you
  want to route
- Leave `LITELLM_MASTER_KEY=CHANGE_ME` and `LITELLM_SALT_KEY=CHANGE_ME` —
  `deploy.sh` generates and saves random values for both on first run.
  **Back up the salt key once it's generated** — it can't be rotated later
  without losing access to every stored virtual key and provider credential.

`.env.db` needs no edits for a first deploy — `POSTGRES_PASSWORD=CHANGE_ME`
is generated the same way as the other secrets.

Edit `config/config.yaml` to add/remove models — see the
[LiteLLM config docs](https://docs.litellm.ai/docs/proxy/configs).

## 2. Deploy

```bash
chmod +x scripts/*.sh
./scripts/deploy.sh
```

First run takes a few minutes (VM boot + image pull). The script prints the
external IP, the master key, and a ready-to-run test `curl` command.

Re-run `./scripts/deploy.sh` any time after editing the `.env` files or
`config/config.yaml`. For an existing VM, the script updates instance metadata
and then immediately runs the reconciliation script over SSH instead of waiting
for a reboot/startup-script cycle. If `LITELLM_IMAGE` changed, the old LiteLLM container and image are removed
**before** downloading the replacement. This avoids temporarily keeping two
large LiteLLM images on the small VM disk. Unused Docker images/build cache are
also pruned, but Docker volumes and `/var/lib/litellm-postgres-data` are never
pruned. If a pull still reports `no space left on device` (for example with a
mutable tag), the VM performs one stronger Docker cleanup without `--volumes`
and retries the pull once. `deploy.sh` then verifies that the running container
reports the requested image before it declares success. Postgres stays on the
same VM, so budgets, virtual keys, and spend data survive LiteLLM image upgrades
and normal deploys.

The deployment first tries SSH through Google IAP (matching the firewall rule
created by the script), then falls back to normal SSH if your project already
permits it. A deploy now fails visibly if it cannot reach the VM or if the
running image does not match `LITELLM_IMAGE`.

## 3. Test

```bash
curl http://<EXTERNAL_IP>:4000/v1/models \
  -H "Authorization: Bearer <LITELLM_MASTER_KEY>"

curl http://<EXTERNAL_IP>:4000/v1/chat/completions \
  -H "Authorization: Bearer <LITELLM_MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hello"}]}'
```

Log into `/ui` at `http://<EXTERNAL_IP>:4000/ui` with user `admin` and the
master key as the password. From there — or via the API below — you can
issue a budgeted key:

```bash
curl -X POST http://<EXTERNAL_IP>:4000/key/generate \
  -H "Authorization: Bearer <LITELLM_MASTER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"max_budget": 20, "budget_duration": "30d"}'
```

## 4. Tear down

```bash
./scripts/teardown.sh
```

## Trade-offs of this setup

- **Postgres on the same VM, not Cloud SQL** → budgets/keys/spend data lives
  on the instance's boot disk. It survives reboots and `deploy.sh` re-runs,
  but is lost if the instance is deleted, and there's no automated backup or
  point-in-time recovery. Swap `DATABASE_URL` to a Cloud SQL instance if you
  need durability guarantees.
- **No TLS** → the proxy is served over plain HTTP on port 4000. Put a
  reverse proxy (Caddy/nginx with Let's Encrypt) or a GCP HTTPS load balancer
  in front of it if you need encryption in transit; that adds cost.
- **2GB RAM (`e2-small`)** → a 2GB swapfile is created automatically for
  extra headroom running Postgres + LiteLLM together, but sustained heavy
  traffic may still want `e2-medium`. The swapfile, Docker images, and Postgres
  data all use the COS stateful partition, so a very large future LiteLLM image
  may outgrow a 10GB boot disk even after cleanup. In that case increase
  `BOOT_DISK_SIZE_GB` for a larger/new VM disk. Change `MACHINE_TYPE` in
  `.env.gcp` and re-run `deploy.sh` (note: changing machine type requires the
  instance to be stopped first; `gcloud compute instances set-machine-type` or
  delete/recreate).
- **Open to the whole internet** (`ALLOWED_SOURCE_RANGE=0.0.0.0/0`) → access
  is still gated by the master key, but narrow this CIDR if you want
  network-level restriction too. Postgres itself is not exposed outside the
  VM's internal Docker network.
- **Ephemeral external IP** → free while the instance is running, but it
  will change if the instance is deleted and recreated. Reserve a static IP
  (small extra cost) if you need a fixed address.
- **No Redis** → budgets and rate limits are accurate for this single-replica
  setup; Redis only becomes necessary if you scale to multiple LiteLLM
  containers/replicas sharing the same counters.

## Local Podman Compose

Local-only files live under `local/` so they stay separate from the GCP
deployment:

- `local/podman-compose.yml` — LiteLLM + Postgres + example MCP + local test app
- `local/example-mcp.js` — dependency-free Node.js MCP server exposing `echo` and `add`
- `local/test-app.js` — dependency-free Node.js server that serves a small HTML/JS LiteLLM + MCP tester
- `local/podman-compose.override.yml.example` — safe template for local provider-key overrides

The main compose file contains only local LiteLLM/Postgres credentials. Keep real
provider credentials in an ignored override file:

```bash
cd local
cp podman-compose.override.yml.example podman-compose.override.yml
# edit GEMINI_API_KEY in podman-compose.override.yml

podman compose \
  -f podman-compose.yml \
  -f podman-compose.override.yml \
  up -d
```

There is deliberately no `restart:` policy, so the containers do not become a
machine-startup service. Start them explicitly with `podman compose up`.

Open:

- LiteLLM UI: `http://localhost:4000/ui`
- Local MCP test app: `http://localhost:3002`
- Example MCP directly: `http://localhost:3001/mcp`

Sign into the LiteLLM UI as `admin`, using the `LITELLM_MASTER_KEY` value from
`local/podman-compose.yml` as the password.

The local test app accepts a **user virtual key** and can send a normal prompt,
run it with all MCP tools, or restrict the request to Notion/example MCP. For
Notion, use a virtual key that has a LiteLLM `user_id`: LiteLLM stores interactive
OAuth credentials by `(user_id, server_id)`, so a service key with no user cannot
own the Notion credential.

When Notion is selected, the app checks LiteLLM's per-user OAuth credential
status first. If login is missing/expired it shows a clear login panel. **Log in
to Notion** starts OAuth + PKCE in a popup. The callback returns to the local app,
the app exchanges the code through LiteLLM, and then stores the resulting
access/refresh token with LiteLLM's `oauth-user-credential` endpoint using that
same virtual key. The browser never receives the Notion tokens.

The Postgres database persists in the named volume `litellm-postgres-data`.
Normal restarts and `podman compose down` preserve it. To intentionally wipe the
local LiteLLM database as well:

```bash
podman compose down -v
```

### Test the example MCP directly

```bash
curl -s http://localhost:3001/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Test LiteLLM MCP with a virtual key

For direct MCP traffic, prefer `x-litellm-api-key` so the `Authorization` header
remains available for upstream OAuth:

```bash
curl -s http://localhost:4000/notion/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "x-litellm-api-key: Bearer $LITELLM_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
