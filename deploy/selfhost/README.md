<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Self-host layout

The files a self-hosted, single-VM Alethia install is built from. The hosted service has its own
layout in `deploy/prod/`; nothing here inherits from it.

| File | What it is |
|---|---|
| `docker-compose.selfhost.yml` | The production overlay, layered on the repository's `docker-compose.yml` |
| `Caddyfile` | The ingress the overlay mounts: automatic TLS for `ALETHIA_DOMAIN`, `/docs` and `/news` routing |
| `secrets.manifest` | Every secret the instance generates for itself: name, generator, presence, consumers |
| `secrets.sh` | POSIX `sh` helpers that read the manifest: list, generate, fill missing, recognise a template placeholder |
| `preflight.sh` | The check the `preflight` service runs before `migrate`: every instance secret set and not a placeholder |
| `rotate-secret.sh` | Rotates one instance secret on a box, with only a shell, `openssl` and `docker compose` |
| `README.md` | This page: the layout, `ALETHIA_VERSION`, the manifest format and how the pieces change |

## Status

`deploy/install.sh` installs with this overlay. It generates every `required` manifest entry
(through `secrets.sh`), records `ALETHIA_VERSION` in `.env`, runs `preflight.sh` against `.env`, and
only then pulls and starts the stack. The base `docker-compose.yml` also refuses to render while a
secret it references is empty.

`scripts/validate-selfhost.sh` checks this layout statically: the manifest against the installer and
the templates, every generator, the rendered overlay (preflight before `migrate`, a `self` runner,
every image at `ALETHIA_VERSION`, this `Caddyfile`), and `preflight.sh` refusing a placeholder in
each entry. It is not yet run by CI; wiring it into a workflow is outside lane H1's scope.

## Rendering the overlay

```sh
docker compose -f docker-compose.yml -f deploy/selfhost/docker-compose.selfhost.yml config
```

`config` only renders the merged model; it starts nothing. It reads `.env` from the repository root.
It exits non-zero and names the variable when `ALETHIA_VERSION` or any `required` manifest secret is
missing or empty.

What the overlay sets, relative to the base bundle:

- Every image is pulled from GHCR at one tag, `ALETHIA_VERSION`. Nothing is built on the VM.
- The bundled runner is self-operated: `ALETHIA_RUNNER_OPERATOR: self`. It registers with the
  console using `ALETHIA_RUNNER_BOOTSTRAP_TOKEN`, which the overlay passes to both `app` and
  `runner`.
- The `marketing` service is hosted-only. The overlay moves it to a profile it never enables, so
  `COMPOSE_PROFILES=marketing` does not start it.
- Caddy serves `ALETHIA_DOMAIN` with automatic TLS, using `deploy/selfhost/Caddyfile`. With
  `ALETHIA_DOMAIN` empty it serves plain HTTP on port 80.
- A one-shot `preflight` service runs `preflight.sh` in the `console-migrate` image before
  `migrate`. It exits non-zero, naming each variable, when a `required` secret is empty or any
  manifest secret holds a template placeholder or a published sample value. Nothing after it starts.
- Postgres and the object store are not published to the host. Only Caddy's ports 80 and 443 are.
- Every `required` secret in `secrets.manifest` is referenced as `${NAME:?…}`. No secret has a
  default.

## `ALETHIA_VERSION`

One tag pins every Alethia image the stack runs: `console`, `console-migrate`, `runner`, `docs` and
`blog`. It has no default, so an instance always runs a version someone chose, and every container
runs the same one.

| Today | After platform releases (lane H3) |
|---|---|
| Images are tagged `latest` and with the commit SHA of the `main` deploy that built them. A deploy builds only the images its change touched, so check that a SHA carries all five images before pinning it. `deploy/install.sh` records `latest` on a first install unless `ALETHIA_VERSION` is given; with `latest`, each `pull` can move the instance to a newer build. | A `platform` release produces `vX.Y.Z`, every image carries that tag, and `deploy/releases.json` records the set. `ALETHIA_VERSION=vX.Y.Z` selects it, and the installer defaults to the latest release. |

Upgrade policy: move one minor version at a time. The `migrate` service runs to completion before
`app` starts, so the schema always moves first. Rollback means restoring from a backup taken before
the upgrade, never running an older image against a newer schema.

## The secrets manifest

Every instance secret is declared in `secrets.manifest`, generated per install, and has no default.
The file states its own format in its header. In short, it holds two kinds of record:

```text
generator <id> <command…>
secret    <NAME> <generator-id> <presence> <installer> <consumers>
```

- A **generator** names a value shape (`hex32`, `base64-32`, `rsa-2048-pem`, `ed25519-raw`, …) and
  gives the POSIX `sh` command that makes one value of that shape.
- A **secret** gives the variable name, its generator, whether it is `required` or `optional`,
  whether `deploy/install.sh` generates it today (`yes` or `no`), and the compose services that read
  it.

`required` entries make the overlay refuse to render when they are missing. `optional` entries each
turn on one feature; with the variable unset the feature stays off and its endpoints refuse.

Who reads the manifest:

| Reader | What it does with it | Lane |
|---|---|---|
| `deploy/install.sh` | Generates every `required` entry on a first install, adds any missing one on an upgrade, never rewrites an existing value, and warns about a template placeholder | H0b |
| `scripts/dev-env.sh` | The same for a local development `.env` | H0b |
| `rotate-secret.sh` | Generates the replacement value for one entry | H0b |
| `scripts/validate-selfhost.sh` | Asserts every `required` entry is generated by the installer, runs every generator, checks that `.env.example` carries an empty placeholder for each entry and that no compose file gives one a default | H0b |
| `preflight.sh` | Runs as the `preflight` service before `migrate`, and in `deploy/install.sh` before the stack starts. Exits non-zero, naming the variable, when a `required` entry is empty or any entry is a placeholder | H1 |
| Console | Refuses to start in production on a template placeholder (`lib/crypto/secrets.ts`) | H0b |
| Console and runner | Make the full presence check at boot when `NODE_ENV=production` | H2 |
| Helm chart | Its Secret carries the same set | H8 |

### Credentials the operator supplies

These come from a third party, so the installer cannot generate them and the manifest does not list
them. Each is optional and turns on one integration. Set them in `.env`.

| Integration | Variables |
|---|---|
| Sign-in with an OAuth provider | `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`, `GITLAB_SECRET`, `BITBUCKET_KEY`, `BITBUCKET_SECRET` |
| Email | `ALETHIA_SES_ACCESS_KEY_ID`, `ALETHIA_SES_SECRET_ACCESS_KEY`, or `SMTP_USER` and `SMTP_PASS` |
| The assistant | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `AI_GATEWAY_API_KEY` |
| Cost estimates | `INFRACOST_API_KEY` |
| Billing (off by default) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Token clouds on the bundled runner | `HCLOUD_TOKEN`, `DIGITALOCEAN_ACCESS_TOKEN`, `CIVO_TOKEN` |
| Enterprise edition | `ALETHIA_LICENSE_KEY` |
| A runner registered by hand | `ALETHIA_RUNNER_ID`, `ALETHIA_RUNNER_TOKEN`, issued by the console. The bundled runner does not need them. |

## Rotating a secret

```sh
sh deploy/selfhost/rotate-secret.sh <NAME>     # sh deploy/selfhost/rotate-secret.sh --list
```

It generates the new value with the entry's generator, writes it to `.env` and recreates what reads
it. The entries with state behind them get the extra steps they need: the credential encryption key
keeps its predecessor in the keyring and re-encrypts every stored secret inside the `migrate` image;
the OIDC signing key keeps its predecessor published as `ALETHIA_OIDC_SIGNING_KEY_PREVIOUS`; the
database passwords change the role in Postgres first; the storage keys recreate the object store.
It needs no Node toolchain on the box.

## Changing the layout

- **A new instance secret** gets a `secret` line in `secrets.manifest` and, when it is `required`,
  a `${NAME:?…}` reference in the overlay on every service that reads it. Never give it a default,
  in the overlay or anywhere else in the self-host path.
- **A new value shape** gets a `generator` line whose command prints exactly one value on one line.
- **A new service** in the base bundle that the self-hosted instance must not run is moved to the
  `hosted-only` profile in the overlay.
- **A secret that stops being read** is removed from the manifest and the overlay in the same change.
