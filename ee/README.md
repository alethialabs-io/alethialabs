<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: LicenseRef-Alethia-Commercial
-->

# Enterprise Edition (`ee/`)

Source-available, **commercially licensed** features — see [`ee/LICENSE`](./LICENSE)
(`LicenseRef-Alethia-Commercial`). Everything outside this directory is
`AGPL-3.0-only`.

Production use of code under `ee/` requires a valid Alethia Labs subscription. You
may read, fork, and contribute to it, but you may not run it in production without
a subscription.

## What lives here

Cloud / enterprise features that are **not** part of the open-source core:

- Role-based access control (RBAC)
- Single sign-on (SSO) — SAML / OIDC
- Teams and organizations
- Other future enterprise / cloud capabilities

## Instance licensing (signed-JWT entitlement)

A **self-managed / air-gapped enterprise** unlocks every feature for the whole instance by
installing a **signed license** — a compact EdDSA (ed25519) JWT that Alethia Labs mints offline.
This replaces the old `ALETHIA_LICENSE_ACTIVE=true` placeholder (still honored, but **only outside
production**, as a local-dev convenience).

- **`src/license.ts`** — the verifier. Reads the license from `ALETHIA_LICENSE_KEY` and verifies it
  **offline** against the issuer public key baked into `ALETHIA_LICENSE_PUBLIC_KEY` (base64 SPKI PEM,
  same env convention as the OIDC issuer's `ALETHIA_OIDC_SIGNING_KEY`). Pins `iss`/`aud` and enforces
  `exp`; **fail-closed** — a missing, malformed, expired, or forged license leaves the instance
  UNlicensed and falls back to per-org billing entitlements. Never crashes boot.
- **`src/license-issue.ts`** — the issuer (`issueLicense`, `generateLicenseKeypair`). The **private**
  signing key lives ONLY in the Alethia ops vault — never in this repo, never on a customer instance.

Config on a licensed instance:

| Env | Meaning |
| --- | --- |
| `ALETHIA_LICENSE_KEY` | the signed license JWT (the "license file" the customer installs) |
| `ALETHIA_LICENSE_PUBLIC_KEY` | base64(SPKI PEM) ed25519 **public** key the license verifies against |
| `ALETHIA_LICENSE_ACTIVE` | `true` unlocks a **non-production** instance only (dev bypass); ignored in prod |

> Wiring the two new vars into the hosted deploy's env-emit list is a separate ops task (outside the
> `ee/**` scope of this change).

## Conventions

- Every file under `ee/` carries `SPDX-License-Identifier: LicenseRef-Alethia-Commercial`.
- Core (AGPL) code must **not** depend on `ee/` code; `ee/` may depend on core.
- Today, authentication is still implemented inline in `apps/console/app/(public)/auth`
  and `apps/console/app/api/auth`. As the enterprise auth surface (SSO, RBAC, teams)
  is built out, it moves here.

## Why this is allowed

Alethia Labs DPK holds copyright across the whole codebase (contributions are
consolidated via the [CLA](../cla/)). The AGPL binds *licensees*, not the
copyright holder — so Alethia Labs DPK may combine this commercially-licensed code with
the AGPL core and ship proprietary editions. See [`LICENSING.md`](../LICENSING.md).
