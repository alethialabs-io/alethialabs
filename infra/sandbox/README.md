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
| `cloudflare_record.env_wildcard` | `*.dev` → the tunnel. One record covers every future branch. |
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

## Sizing, and why this is x86

The default is **`cpx42`** (8 vCPU / 16 GB / 320 GB). Sized from measurement, not
guesswork: the shared datastore tier costs ~0.5 GB live RSS, each `next dev` ~2 GB,
and a warm Go build ~1 GB — so 16 GB holds `env_cap = 3`.

It is x86 rather than the ~3× cheaper ARM `cax31` for three reasons, in order of how
much they bite:

1. **ARM is out of stock in EU.** Checked 2026-07-27: `nbg1`, `hel1` and `fsn1` list
   zero `cax` types as available. The same scarcity is already recorded in
   `infra/cp-hetzner/variables.tf`.
2. **It interacts badly with reaping.** A Hetzner snapshot is architecture-bound, so
   an ARM box snapshotted and deleted during a capacity crunch **cannot be restored
   at all** until stock returns. x86 has no such cliff.
3. **x86 matches the fleet.** Runner images ship `linux/amd64`; an ARM box builds
   `arm64`, which is precisely the mismatch behind the ~100-VM/8h fleet churn
   incident.

Because reaping bills hourly, the sticker price is not what you pay:

| Type | | Sticker | At 8h × 22d |
|---|---|---|---|
| `cpx32` | 4c / 8 GB / 160 GB | €35.49 | ~€10.01 |
| **`cpx42`** | **8c / 16 GB / 320 GB** | **€69.49** | **~€19.61** |
| `cpx62` | 16c / 32 GB / 640 GB | €138.49 | ~€39.06 |
| `cax31` *(unavailable)* | 8c / 16 GB / 160 GB | €20.99 | ~€5.92 |

Set `server_type = "cax31"` once ARM returns; `pnpm env:up` preflights capacity and
names alternatives before `tofu` runs, so you get a clear message rather than
`resource_unavailable`.

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
