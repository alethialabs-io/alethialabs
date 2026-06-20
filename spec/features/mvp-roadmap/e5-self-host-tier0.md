# E5 — Self-host distribution: Tier-0 launch-ready

**Goal:** a fresh operator runs one command and gets a working Alethia control plane, then completes
the hero flow (E1). The OSS adoption funnel. Community/core.

## Status
Core self-host is done (Docker Compose: app · postgres · seaweedfs · runner · caddy · migrate;
Better Auth; SSE; OpenTofu). What remains is the polished, validated **Tier-0** experience.

## Tasks
- [ ] `deploy/install.sh` one-command install (`curl … | sh`) validated end-to-end on a clean box;
      pulls public GHCR images, no on-box build.
- [ ] Caddy auto-TLS verified with a real domain (`ALETHIA_DOMAIN`/`ALETHIA_ACME_EMAIL`).
- [ ] The deferred live `docker compose up` → **hero-flow round-trip** (ties into E1's proof run).
- [ ] Idempotent re-run; clear `.env.example` as the single source of truth.
- [ ] Self-hoster quickstart docs (much already in `apps/docs/`).

## Done when
A fresh operator goes from `curl | sh` to a green hero-flow run with zero manual steps beyond `.env`.
