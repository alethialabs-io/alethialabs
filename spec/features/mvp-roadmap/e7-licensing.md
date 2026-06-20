# E7 — Licensing & open-core hygiene

**Goal:** the AGPL community core and the commercial `ee/` tier are cleanly separated and CI-enforced.
Cross-cutting; small.

## Status
SPDX headers are largely present; root `LICENSE` (AGPL-3.0) exists. The boundary is convention, not
enforced.

## Tasks
- [ ] Confirm root `LICENSE` = AGPL-3.0-only and `ee/LICENSE` = the commercial license; SPDX headers on
      new files.
- [ ] **CI boundary guard:** fail the build if any non-`ee/` file imports from `ee/` (direction of
      dependency is `ee/` → core, never reverse). A lint/grep step in CI.
- [ ] Ties into **E2**'s license entitlement: the `ALETHIA_LICENSE_ACTIVE` env-var placeholder in
      `ee/src/index.ts` becomes a real signed-JWT verification + a minimal license issuer — the gate
      for every paid feature (and thus revenue).
- [ ] (Post-MVP) REUSE compliance + CLA bot + license-scan CI.

## Done when
CI blocks core→ee imports; entitlements are gated by a real signed check, not an env var.
