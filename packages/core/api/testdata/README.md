<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# CLI contract fixtures — generated

These `*.json` files are **generated**, not hand-authored. They are deterministically
sampled from the Zod CLI wire contract by:

```
pnpm -F console gen:cli-fixtures
```

(source: `apps/console/scripts/gen-cli-fixtures.ts` ← `apps/console/lib/validations/cli-contract.ts`)

Do not edit them by hand. To change a fixture, change the contract (which derives from the
Drizzle schema via `createSelectSchema`) and regenerate.

They are the shared half of the type-drift guard:

- **Go** (`packages/core/api/contract_test.go`) strict-decodes each fixture into the hand-curated
  `api.go` structs — a new wire field the Go struct doesn't model, or a struct field the wire
  dropped, fails the test and names the field.
- **TS** (`apps/console/tests/validations/cli-contract.test.ts`) parses each fixture against its
  contract schema — a stale fixture fails here.
- **CI** runs `gen:cli-fixtures` + `git diff --exit-code` on this directory, so a contract change
  that isn't regenerated fails the build.
