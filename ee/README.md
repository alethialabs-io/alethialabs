<!--
SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
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

## Conventions

- Every file under `ee/` carries `SPDX-License-Identifier: LicenseRef-Alethia-Commercial`.
- Core (AGPL) code must **not** depend on `ee/` code; `ee/` may depend on core.
- Today, authentication is still implemented inline in `apps/console/app/(public)/auth`
  and `apps/console/app/api/auth`. As the enterprise auth surface (SSO, RBAC, teams)
  is built out, it moves here.

## Why this is allowed

Alethia OÜ holds copyright across the whole codebase (contributions are
consolidated via the [CLA](../cla/)). The AGPL binds *licensees*, not the
copyright holder — so Alethia OÜ may combine this commercially-licensed code with
the AGPL core and ship proprietary editions. See [`LICENSING.md`](../LICENSING.md).
