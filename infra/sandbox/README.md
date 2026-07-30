<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# infra/sandbox — the dev box

One Hetzner VPS that runs every branch environment, so the Mac stops being a runtime.
You almost never run `tofu` here directly: **`pnpm env:up` drives this stack for you**,
including creating the box on first use and restoring it from a snapshot after a reap.

This is the infrastructure half. The runtime half — the registry, the per-env
databases and the `next dev` processes — is `scripts/env.sh` and `scripts/box/*`.

## What it creates

| Resource | Why |
|---|---|
| `hcloud_server.sandbox` | The box. No data volume — see *Durability* below. |
| `hcloud_firewall.sandbox` | SSH and nothing else; envs are reached through the tunnel. |
| `cloudflare_zero_trust_tunnel_cloudflared.sandbox` | **Locally-managed** (`config_src = "local"`), so the box can rewrite ingress as envs come and go. |
| `cloudflare_record.env_slot` | One record per env slot: `env1-dev`, `env2-dev`, … **one label deep**, so Universal SSL covers them. |
| `cloudflare_record.env_primary` | `dev` → the tunnel. The one hostname with OAuth + Stripe registered. |

No `cloudflared tunnel login`, no hand-copied credentials file: the connector
credentials are derived from state (`tofu output -raw tunnel_credentials`) and
installed by `env:up`.

## First run

```bash
cp terraform.tfvars.example terraform.tfvars   # fill in tokens + your SSH key
tofu init
tofu plan          # review
tofu apply         # a human runs this, never an agent
```

Then, from the repo root, `pnpm env:up`.

## Sizing and cost

Default **`cpx32`** (4 vCPU / 8 GB / 160 GB). Sized for **cost**, because billing is hourly
and the box is removed when idle.

| | per hour | 6h/day x 22d | always-on |
|---|---|---|---|
| **cpx32** | EUR 0.0569 | **~7.51** | 35.49 |
| cpx42 | EUR 0.1114 | ~14.70 | 69.49 |

Idle floor is about **EUR 0.80/mo**: the Primary IP (0.50) plus the snapshot
(~20 GB at 0.0143/GB). 8 GB still fits the shared tier (~1 GB), two environments
(~2-3 GB each) and a Chromium run.

**A stopped server is not free.** Hetzner bills *"for a server ... for as long as it
exists, regardless of whether it is turned on or not"*, so stop/start saves nothing and
removal is the only lever. That is why the lifecycle is snapshot-and-remove rather than
power-off.

**Going to a smaller type cannot use a snapshot.** Hetzner refuses to restore onto a
smaller disk, so a cpx42 (320 GB) snapshot will not boot a cpx32 (160 GB). Downsizing means
letting the box go and building fresh; upsizing is fine.

It is x86 rather than the cheaper ARM `cax31` because ARM has been out of stock EU-wide
(same scarcity `infra/cp-hetzner/variables.tf` records), snapshots are architecture-bound
so an ARM box could not be restored during a shortage, and the runner fleet ships
`linux/amd64`.

## Durability

There is **no attached data volume**, unlike `infra/cp-hetzner`. This box is designed
to be snapshotted and *deleted* when idle — a stopped Hetzner server still bills, a
deleted one does not, and a volume would keep billing after the delete. Durability
comes from the snapshot instead.

That is an accepted trade: the only state worth keeping is seeded dev databases and
warm `node_modules`, both cheap to rebuild. Nothing here is a system of record.

**While the box is reaped, `dev.alethialabs.io` returns Cloudflare error 1033** — the
tunnel dies with the box. `pnpm env:up` brings it back in 1–2 minutes. If that proves
annoying in practice, raising the reap threshold is a one-line change in
`scripts/env.sh`.

## Why slot hostnames, not branch names

Branch envs are `envN-dev.<domain>`, keyed to the registry's slot rather than the branch.

The original design used `<slug>.dev.<domain>` behind a `*.dev` wildcard. DNS resolved and
the tunnel routed correctly — and every request failed TLS:

```
dev.alethialabs.io          matched cert's "*.alethialabs.io"   OK
fix-trap.dev.alethialabs.io sslv3 alert handshake failure       FAILS
```

Cloudflare's Universal SSL covers the apex and **one** level of subdomain. Two levels needs
an Advanced Certificate, which costs about what the box does. A record per slot is one
label deep, created once here, needs no Cloudflare API call during `env:up`, and avoids a
wildcard that would catch every unregistered subdomain of the production zone.

## The OAuth constraint

OAuth redirect URIs cannot contain wildcards. So:

- **`dev.alethialabs.io`** is the primary env — social sign-in and the Stripe test
  webhook are registered against it.
- **`<slug>.dev.alethialabs.io`** branch envs get HTTPS but are **email-OTP only**.
  This is not a limitation to work around: with no `ALETHIA_SES_REGION` set, the
  console logs the sign-in code instead of mailing it, so `pnpm env:logs` is where
  you read it. No credential is copied to the box to make sign-in work.

`pnpm env:status` prints this rather than letting someone rediscover it.

## Conventions

Per the repo's IaC rules: one file per component (`server.tf`, `network.tf`,
`tunnel.tf`, `variables.tf`, `outputs.tf`, `checks.tf`), `check` blocks asserting each
new resource's invariants, and `tofu fmt -recursive` + `init` + `validate` before every
commit. **`tofu apply` and `plan -destroy` are for humans only.**

State is **local** and gitignored — unlike `cp-hetzner`'s S3 backend, which exists
because CI applies it. Losing the state file costs one `tofu import` of the server,
not any data.
