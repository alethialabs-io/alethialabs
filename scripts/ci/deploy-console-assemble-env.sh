#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# The production deploy: read alethia/prod/env from the vault, assemble the box's `.env`, ship it,
# and roll the stack — then prove the public URL serves. Run by `deploy-console.yml`'s `deploy`
# job, step "Assemble .env from the vault and deploy", and by nothing else.
#
# WHY THIS IS A FILE AND NOT A `run:` BLOCK (#6582). It was a 22 KB block scalar, over the
# 21000-byte ceiling Actions puts on a template expression. It loaded only because it contained no
# `${{ … }}`: one interpolation written into it — even inside a comment — would have made Actions
# compile the whole block as an expression and refuse the WHOLE FILE, which is a run with zero jobs,
# no red check on any PR, and production silently not deploying. `check-workflow-shape.mjs` now
# fails on any block over its budget, templated or not.
#
# THE ENV CONTRACT. Everything this reads comes from the environment, never from interpolation:
#
#   ASM_SECRET_ID, ASM_REGION   job env (literals)
#   IMAGE_TAG                   job env, `${{ github.sha }}`
#   APPS_BUILT                  job env, `${{ needs.changes.outputs.apps_build }}`
#   AWS_* credentials           exported by aws-actions/configure-aws-credentials (OIDC)
#
# Do not add a `${{ }}` to this file — it is not a template, and the text would reach bash
# verbatim. A new input is a new `env:` entry on the step or job.
#
# `deploy/prod/README.md` calls the `emit` list below "the real gate": a vault key reaches the box
# only if a line here writes it. `scripts/ci/check-deploy-required-keys.py` reads the
# `[ -n "$X" ] || … exit 1` gates from this file, and
# `apps/console/tests/unit/dockerfile-runtime-public-env.test.ts` reads the emit lines.

set -euo pipefail
# The contract above, checked before anything touches the vault or the box. `?` without `:` refuses
# only an UNSET variable: an EMPTY `APPS_BUILT` was accepted by the inline step and still is, so the
# only behaviour this adds is failing earlier where `set -u` would have failed later — after the
# first ssh had already pruned the box.
: "${ASM_SECRET_ID?ASM_SECRET_ID is not set — run this from the deploy job of deploy-console.yml}"
: "${ASM_REGION?ASM_REGION is not set — run this from the deploy job of deploy-console.yml}"
: "${IMAGE_TAG?IMAGE_TAG is not set — run this from the deploy job of deploy-console.yml}"
: "${APPS_BUILT?APPS_BUILT is not set — run this from the deploy job of deploy-console.yml}"
json="$(aws secretsmanager get-secret-value --secret-id "$ASM_SECRET_ID" --region "$ASM_REGION" --query SecretString --output text)"
val() { printf '%s' "$json" | jq -r --arg k "$1" '.[$k] // ""'; }

HOST="$(val DEPLOY_HOST)"
[ -n "$HOST" ] || { echo "::error::DEPLOY_HOST not in $ASM_SECRET_ID yet — run infra-cp-hetzner (provision) first."; exit 1; }
APP_URL="$(val PUBLIC_APP_URL)"; APP_URL="${APP_URL:-https://alethialabs.io}"
SERVER_TYPE="$(val HCLOUD_SERVER_TYPE)"; SERVER_TYPE="${SERVER_TYPE:-cax21}"
PUBLIC_PHONE="$(val ALETHIA_PUBLIC_PHONE)"
[ -n "$PUBLIC_PHONE" ] || { echo "::error::ALETHIA_PUBLIC_PHONE is required for the production company-information surface."; exit 1; }
RESEND_KEY="$(val RESEND_API_KEY)"
[ -n "$RESEND_KEY" ] || { echo "::error::EMAIL_PROVIDER=resend requires RESEND_API_KEY."; exit 1; }

# Sender addresses — vault first, apex fallback. The fallback domain MUST be one the
# provider has verified; a subdomain here is rejected at send time, long after this job
# has reported success. See the note at the emit site below.
AUTH_FROM="$(val AUTH_EMAIL_FROM)"; AUTH_FROM="${AUTH_FROM:-Alethia <no-reply@alethialabs.io>}"
GENERAL_FROM="$(val EMAIL_FROM)"; GENERAL_FROM="${GENERAL_FROM:-Alethia <hello@alethialabs.io>}"

# SSH private key from the vault (never touches the runner env / logs).
mkdir -p ~/.ssh && chmod 700 ~/.ssh
val DEPLOY_SSH_PRIVATE_KEY > ~/.ssh/deploy_key
chmod 600 ~/.ssh/deploy_key

# Assemble .env locally, then scp it to the box. Internal service URLs
# (Postgres/SeaweedFS) come from the compose files, not here.
umask 077
emit() { printf '%s=%s\n' "$1" "$(val "${2:-$1}")"; }
{
  echo "NEXT_PUBLIC_APP_URL=$APP_URL"
  echo "BETTER_AUTH_URL=$APP_URL"
  echo "NEXT_PUBLIC_SITE_URL=$APP_URL"
  echo "NEXT_PUBLIC_LEGAL_URL=$APP_URL"
  # This IS the hosted control plane. Without it deploymentMode() defaults to "self-managed"
  # (lib/billing/config.ts), which hides the feedback widget and exposes self-managed runner /
  # fleet UI to customers. Constant here — the box is always hosted.
  echo "ALETHIA_DEPLOYMENT_MODE=hosted"
  emit ALETHIA_PUBLIC_PHONE
  emit BETTER_AUTH_SECRET
  # Stable Next.js Server Actions encryption key — shared by console/admin/marketing (one
  # .env, one env_file). Unset ⇒ random per build ⇒ "Server Action was not found" skew when
  # a page is open across a deploy. Generated once into the vault by bootstrap-secrets.sh.
  emit NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
  emit CLI_JWT_SECRET
  # Auth brute-force rate-limit kill-switch (default on; set =0 in the vault to disable).
  # Emit so the disable path actually reaches the console.
  emit ALETHIA_AUTH_RATE_LIMIT
  emit ALETHIA_CRED_ENCRYPTION_KEY
  # config_snapshot authenticity HMAC (lib/runners/snapshot-sig.ts). Absent → signing off.
  emit ALETHIA_SNAPSHOT_HMAC_KEY
  # Credential-encryption key id (keyring) for ONLINE key rotation. Defaults to "1" if the
  # vault key is absent (secrets.ts falls back), so this emit is safe even when unset.
  emit ALETHIA_CRED_ENCRYPTION_KID
  # To ROTATE the credential key with no downtime: add the previous active key to the vault as
  # ALETHIA_CRED_ENCRYPTION_KEY_<oldkid>, add an `emit ALETHIA_CRED_ENCRYPTION_KEY_<oldkid>`
  # line here, set the new active key + bump ALETHIA_CRED_ENCRYPTION_KID, deploy, then run
  # `pnpm -C apps/console run db:reencrypt` on the box. Drop the retired key + its emit line once every
  # row has been re-encrypted. See lib/crypto/secrets.ts for the runbook + ordering.
  echo "ALETHIA_DB_USER=alethia"
  echo "ALETHIA_DB_NAME=alethia"
  emit ALETHIA_DB_PASSWORD
  emit ALETHIA_APP_DB_PASSWORD
  emit OPENFGA_DB_PASSWORD
  emit ALETHIA_STORAGE_ACCESS_KEY_ID
  emit ALETHIA_STORAGE_SECRET_ACCESS_KEY
  echo "ALETHIA_STORAGE_AUTO_CREATE_BUCKETS=true"
  emit TUNNEL_TOKEN
  # PostHog — the all-in-one suite (analytics + replay + web vitals). One external project key;
  # host defaults to eu.i.posthog.com. When set, the console runs PostHog (leave Umami unset).
  emit NEXT_PUBLIC_POSTHOG_KEY
  emit NEXT_PUBLIC_POSTHOG_HOST
  # Structured logs → PostHog Logs over OTLP (lib/observability/otel.ts). Unset ⇒ emitted empty
  # ⇒ the logs provider never registers (the pino→OTel bridge stays a no-op). Endpoint is
  # https://eu.i.posthog.com/i/v1/logs; headers carry `Authorization=Bearer <phc_ project key>`.
  emit OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  emit OTEL_EXPORTER_OTLP_LOGS_HEADERS
  # --- Operability suite (the ~19-PR program). Every one is OFF unless its value is set in the
  # vault: unset ⇒ emitted empty ⇒ the code's gate treats it as disabled (like the AI keys /
  # analytics above). Without these lines the vault vars could never reach the box's .env, so
  # the whole suite would be un-enable-able in prod (the prod-env-emit-gaps trap). ---
  # Generic OTel collector seam and first-party operational controls. Hosted production does
  # not configure the dormant Sentry/GlitchTip adapter.
  emit OTEL_EXPORTER_OTLP_ENDPOINT
  emit OTEL_SERVICE_NAME
  emit ALETHIA_PLATFORM_ALERT_ORG_ID
  emit ALETHIA_LOG_LEVEL
  # Break-glass privileged-recovery surface — DEFAULT-OFF (404 unless ENABLED="true"): the master
  # switch, the operator allowlist (distinct from support staff), the CF-Access proxy secret, and
  # the orphan-clean arm flag (still 501 even when armed). State-surgery's runner arm flag +
  # ALETHIA_CANCEL_GRACE_SECONDS live in the runner's env, not the console .env.
  emit ALETHIA_BREAKGLASS_ENABLED
  emit BREAKGLASS_OPERATORS
  emit BREAKGLASS_ACCESS_PROXY_SECRET
  emit ALETHIA_BREAKGLASS_ORPHAN_CLEAN_ENABLED
  # Reconcile/GC tunables — safe code defaults (converge 5m; log 30d; fleet_actions 90d), set
  # only to override.
  emit ALETHIA_CONVERGE_MIN_AGE_MINUTES
  emit ALETHIA_JOB_LOG_RETENTION_DAYS
  emit ALETHIA_FLEET_ACTION_RETENTION_DAYS
  # Managed runner fleet is OFF by default (no warm Hetzner VMs billed when there
  # are no prod users). A non-"hcloud" value makes the in-app scaler a no-op
  # (getFleetProvider → ManualFleetProvider). Re-enable purely from the vault by
  # setting FLEET_PROVIDER=hcloud in alethia/prod/env — no code change/redeploy-PR needed.
  FLEET_PROVIDER_VAL="$(val FLEET_PROVIDER)"
  echo "FLEET_PROVIDER=${FLEET_PROVIDER_VAL:-manual}"
  echo "HCLOUD_TOKEN=$(val HCLOUD_FLEET_TOKEN)"   # runtime fleet token (not the CP token)
  emit FLEET_POOLS                                 # declarative warm-pool set → seedFleetPoolsFromEnv on boot
  emit HCLOUD_SSH_KEYS
  echo "HCLOUD_SERVER_TYPE=$SERVER_TYPE"
  echo "FLEET_RUNNER_IMAGE_TAG=latest"
  echo "FLEET_RUNNER_SLOTS=1"
  emit ALETHIA_RUNNER_BOOTSTRAP_TOKEN
  emit ALETHIA_CRON_SECRET
  emit RELEASE_API_SECRET
  # Workload-identity OIDC issuer signing key (lib/oidc/issuer.ts) — powers keyless Azure +
  # Alibaba federation. Auto-generated by bootstrap-secrets.sh; served via /api/oidc JWKS.
  emit ALETHIA_OIDC_SIGNING_KEY
  # Second, published-but-not-signing key set ONLY during a rotation (scripts/rotate-oidc-key.sh)
  # so the outgoing key keeps verifying in-flight assertions through the overlap. Empty otherwise.
  emit ALETHIA_OIDC_SIGNING_KEY_PREVIOUS
  # Signs the evidence receipt (packages/core/verify, SigningKeyFromEnv). Auto-generated by
  # bootstrap-secrets.sh. Absent, signing degrades SILENTLY: the apply still succeeds and
  # still attaches a receipt, but with algorithm:"none" — evidence that proves nothing.
  emit ALETHIA_RECEIPT_SIGNING_KEY
  # Evidence receipt Rekor anchoring (#885, lib/evidence/receipt-anchor.ts). The anchor key
  # (ECDSA-P256) is auto-generated by bootstrap-secrets.sh; the flag/URL/log-key are set in
  # the vault by the operator to enable + point at a log. All empty ⇒ anchoring stays off.
  emit ALETHIA_REKOR_ANCHOR_ENABLED
  emit ALETHIA_REKOR_URL
  emit ALETHIA_REKOR_LOG_PUBLIC_KEY
  emit ALETHIA_RECEIPT_ANCHOR_KEY
  emit GITHUB_CLIENT_ID
  emit GITHUB_CLIENT_SECRET
  emit GOOGLE_CLIENT_ID
  emit GOOGLE_CLIENT_SECRET
  # GitLab + Bitbucket go through the genericOAuth plugin; without these the
  # plugin isn't mounted and /api/auth/sign-in/oauth2 404s. Names match what
  # lib/config/auth.ts reads (GitLab = APPLICATION_ID, Bitbucket = KEY).
  emit GITLAB_APPLICATION_ID
  emit GITLAB_SECRET
  emit BITBUCKET_KEY
  emit BITBUCKET_SECRET
  # AWS is KEYLESS and issuer-direct (like GCP/Azure/Alibaba): the customer's IAM role trusts the
  # Alethia OIDC issuer (an IAM OIDC provider), so the console + runner federate straight in via
  # AssumeRoleWithWebIdentity with a minted assertion — no platform AWS account, no static key,
  # nothing to emit. Availability tracks the OIDC issuer (cloud-connect-setup.ts). Only AWS_REGION
  # is set (the SDK wants a default region for the global STS call).
  echo "AWS_REGION=us-east-1"
  # Azure is KEYLESS + customer-side (like GCP/AWS/Alibaba): the customer creates a
  # user-assigned managed identity in their own subscription (its client id stored per
  # connection), and the console + runner authenticate AS it via a minted OIDC assertion —
  # no platform Entra app, no tenant/secret, NOTHING to emit. Availability tracks the OIDC
  # issuer (cloud-connect-setup.ts).
  # Alibaba is KEYLESS + ACCOUNT-FREE: the console assumes the customer RAM role via
  # AssumeRoleWithOIDC with a minted assertion (issuer above) — Alethia holds no Alibaba
  # account / AccessKey, so nothing is emitted; availability tracks the OIDC issuer.
  # GCP needs NO separate secret either — the customer WIF pool trusts the Alethia issuer
  # directly, so the console/runner mint a subject token (audience alethia-gcp-wif). Availability
  # tracks the OIDC issuer (cloud-connect-setup.ts).
  # AI: direct-to-provider (no Vercel AI Gateway). OPENAI_API_KEY is only used for openai/*
  # model overrides (emit tolerates empty). The paid AI tiers (Plus/Max) stay dark until
  # STRIPE_PRICE_AI_* below are set.
  #
  # ⚠️ A KEY IS NO LONGER ENOUGH (#2373). isAiConfigured() FAILS CLOSED until each provider
  # in use also has its DPA, transfer mechanism, retention and no-training commitment
  # recorded — a prompt carries the customer's infrastructure and code, and it does not
  # leave the system until what happens to it is written down. These MUST be emitted: the
  # list is hard-coded, so a variable missing from it never reaches prod and the assistant
  # would be dark with no vault value able to turn it on.
  #
  # The values are PUBLISHED on /ai-transparency, so a placeholder in the vault becomes a
  # false public statement.
  emit ANTHROPIC_API_KEY
  emit OPENAI_API_KEY
  emit ALETHIA_AI_ANTHROPIC_DPA
  emit ALETHIA_AI_ANTHROPIC_TRANSFER
  emit ALETHIA_AI_ANTHROPIC_RETENTION
  emit ALETHIA_AI_ANTHROPIC_NO_TRAINING
  emit ALETHIA_AI_OPENAI_DPA
  emit ALETHIA_AI_OPENAI_TRANSFER
  emit ALETHIA_AI_OPENAI_RETENTION
  emit ALETHIA_AI_OPENAI_NO_TRAINING
  emit STRIPE_SECRET_KEY
  emit STRIPE_WEBHOOK_SECRET
  emit NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  emit STRIPE_PRICE_TEAM
  # Metered (usage-based) prices for managed-runner minutes — without these the usage is
  # metered but never charged through Stripe (lib/billing/config.ts meterPriceIdForPlan).
  emit STRIPE_PRICE_METER_TEAM
  emit STRIPE_PRICE_METER_ENTERPRISE
  # Standalone AI subscription prices — unset ⇒ AI Plus/Max stay dark (AI Free needs none).
  emit STRIPE_PRICE_AI_PLUS
  emit STRIPE_PRICE_AI_MAX
  # Stripe Tax toggle — emit so the vault can flip automatic_tax on WITHOUT editing this
  # workflow. Unset ⇒ emitted empty ⇒ isStripeTaxEnabled() false (lib/billing/config.ts),
  # so tax stays off. Set STRIPE_TAX_ENABLED=true in the vault ONLY after the Stripe
  # account's Tax origin + registrations are configured, else Checkout errors on session create.
  emit STRIPE_TAX_ENABLED
  # Odoo фактура (legal invoice-of-record) — both keys must be non-empty for issueFactura()
  # to post the НАП фактура (lib/billing/odoo-invoice.ts odooConfig). Unset ⇒ emitted empty
  # ⇒ odooConfig() returns null ⇒ the receipt/mirror fall back to Stripe's PDF. Strictly
  # safe default-off (needs BOTH URL + token), same "stay dark when unset" semantics as STRIPE_PRICE_AI_*.
  emit ODOO_INVOICE_URL
  emit ODOO_INVOICE_TOKEN
  # Transactional email: hosted production uses Resend while SES production
  # access remains unavailable. Self-hosted deployments retain every adapter.
  echo "EMAIL_PROVIDER=resend"
  emit RESEND_API_KEY
  # Support: staff Slack ping on a new case/reply (lib/support/slack-notify.ts). Unset → no-op.
  emit SUPPORT_SLACK_WEBHOOK_URL
  # Admin staff dashboard @ admin.alethialabs.io (apps/admin): the Cloudflare-Access allowlist
  # (apps/admin/lib/auth/staff.ts) + the console URL its case deep-links target. COMPOSE_PROFILES
  # activates the profiled `admin` service on the box (docker compose reads it from this .env).
  emit SUPPORT_STAFF_EMAILS
  echo "NEXT_PUBLIC_CONSOLE_URL=$APP_URL"
  echo "COMPOSE_PROFILES=admin"
  # Platform-operator plane (Enterprise onboarding, apps/admin /orgs → console internal
  # routes). The dedicated provisioning bearer is [auto] (bootstrap-secrets.sh, NOT the cron
  # secret); the operator + system-user are the maintainer's own account (const, not
  # secrets); the Stripe Product for enterprise line items comes from the vault ([ext]).
  emit PLATFORM_PROVISION_SECRET
  echo "PLATFORM_ADMIN_EMAILS=borislav@alethialabs.io"
  echo "PLATFORM_SYSTEM_USER_EMAIL=borislav@alethialabs.io"
  emit STRIPE_ENTERPRISE_PRODUCT_ID
  # SENDER ADDRESSES COME FROM THE VAULT. They used to be hardcoded here, on two
  # SUBDOMAINS (no-reply@auth. and hello@mail.), and that silently broke every send.
  #
  # Resend verifies each domain SEPARATELY — verifying `alethialabs.io` does not cover
  # `auth.alethialabs.io` or `mail.alethialabs.io`, and the account has one domain slot.
  # So a valid RESEND_API_KEY was necessary but NOT sufficient: mail would still have been
  # rejected at the provider as an unverified sender, after the deploy reported success.
  #
  # Hardcoding them here also meant the vault's own AUTH_EMAIL_FROM / EMAIL_FROM were dead
  # values that DISAGREED with what shipped (no-reply@ vs hello@) — two sources of truth,
  # one of them inert and neither obviously so.
  #
  # Vault-driven with an apex fallback (the same `${X:-default}` shape this job already
  # uses for PUBLIC_APP_URL and HCLOUD_SERVER_TYPE), so the eventual switch back to SES —
  # which verifies subdomains differently — is a vault edit rather than a PR.
  echo "AUTH_EMAIL_FROM=$AUTH_FROM"
  echo "EMAIL_FROM=$GENERAL_FROM"
  echo "ALETHIA_IMAGE_TAG=$IMAGE_TAG"
} > env.deploy

SSHOPTS="-i $HOME/.ssh/deploy_key -o StrictHostKeyChecking=accept-new"
# Free disk FIRST — the box can fill so completely that even scp'ing the few-KB
# .env fails ("write remote: Failure"). Prune all UNUSED images + build cache
# over ssh before anything writes to the box (running images are protected;
# rollback re-pulls from GHCR). Must run before the scp below.
ssh $SSHOPTS "root@${HOST}" 'df -h /; docker image prune -af || true; docker builder prune -af || true; df -h /'
scp $SSHOPTS env.deploy "root@${HOST}:/opt/alethia/.env.new"
rm -f env.deploy

# On the box: checkout the built SHA, swap in .env, render s3.json from the
# same storage creds (checkout -f resets that tracked file), compose up behind
# the tunnel. `bash -s` gets IMAGE_TAG + the apps build verdict from the ssh env.
ssh $SSHOPTS "root@${HOST}" "IMAGE_TAG='${IMAGE_TAG}' APPS_BUILT='${APPS_BUILT}' bash -s" <<'REMOTE'
set -euo pipefail
cd /opt/alethia
git fetch origin main
git checkout -f "$IMAGE_TAG"
mv -f .env.new .env
AK="$(grep -m1 '^ALETHIA_STORAGE_ACCESS_KEY_ID=' .env | cut -d= -f2-)"
SK="$(grep -m1 '^ALETHIA_STORAGE_SECRET_ACCESS_KEY=' .env | cut -d= -f2-)"
cat > deploy/seaweedfs/s3.json <<JSON
{ "identities": [ { "name": "alethia", "credentials": [ { "accessKey": "${AK}", "secretKey": "${SK}" } ], "actions": ["Admin", "Read", "Write", "List", "Tagging"] } ] }
JSON
cf="-f docker-compose.yml -f deploy/prod/docker-compose.prod.yml -f deploy/prod/docker-compose.tunnel.yml"
# Reclaim disk BEFORE pulling: the box accumulates one sha-tagged image set per
# deploy, and the old `docker image prune -f` (dangling-only, post-pull) never freed
# them → the disk fills and `compose pull` dies with "no space left on device".
# `-af` drops ALL unused images; images backing running containers are protected, so
# this is safe (rollback re-pulls from GHCR). Build cache too (the box never builds).
echo "disk before prune:"; df -h / 2>/dev/null || true
docker image prune -af || true
docker builder prune -af || true
echo "disk after prune:"; df -h / 2>/dev/null || true
docker compose $cf pull
# If `up` fails, the culprit is almost always the one-shot `migrate` service (the app is
# gated on it via depends_on: service_completed_successfully). compose only prints an opaque
# "didn't complete successfully", so dump the migrate container's logs + service status
# BEFORE exiting — makes the real Postgres error visible in the GitHub Actions log (no SSH).
if ! docker compose $cf up -d --remove-orphans; then
  echo "::group::migrate logs (deploy failed)"
  docker logs alethia-migrate-1 --tail 200 2>&1 || true
  echo "::endgroup::"
  echo "::group::compose ps"
  docker compose $cf ps || true
  echo "::endgroup::"
  exit 1
fi
# A SHA tag is only a registry label. Read provenance from the running app container so a
# stale image tagged as this commit cannot turn the production deploy green (#2746). An
# apps build must name this exact SHA. A runner-only release legitimately retags the older,
# code-equivalent console image; `retag-unchanged` already diff-gated that source commit.
app_id="$(docker compose $cf ps -q app)"
deployed_commit="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$app_id" \
  | sed -n 's/^ALETHIA_SOURCE_COMMIT=//p' | head -n1)"
if [ -z "$deployed_commit" ]; then
  echo "::error::Running console carries no ALETHIA_SOURCE_COMMIT provenance."
  exit 1
fi
if [ "$APPS_BUILT" = true ] && [ "$deployed_commit" != "$IMAGE_TAG" ]; then
  echo "::error::Running console provenance '${deployed_commit:-missing}' does not match promoted SHA '$IMAGE_TAG'."
  exit 1
fi
echo "✓ running console carries ALETHIA_SOURCE_COMMIT=$deployed_commit (apps rebuilt: $APPS_BUILT)"
# `git checkout` replaces tracked files atomically. Caddy bind-mounts one
# tracked file, so its existing mount can stay attached to the old inode
# even though /opt/alethia now shows the new routes. Compose cannot detect
# bind-mounted content changes and otherwise reports the container as
# "Running". Recreate it on every release so routing changes take effect.
docker compose $cf up -d --force-recreate --no-deps caddy
docker compose $cf exec -T caddy caddy validate --config /etc/caddy/Caddyfile
# ...and then RESTART CLOUDFLARED, because the recreate above just invalidated it.
#
# `--no-deps` is what makes the line above safe to run on its own, and it is also why the
# tunnel breaks: cloudflared proxies to `http://caddy:80` BY SERVICE NAME over the compose
# network, and it is already running by this point (the `up -d` above started it). Force-
# recreating caddy destroys that container and creates a new one with a NEW IP, while
# cloudflared keeps its pooled connections pointed at the address that no longer exists.
# Cloudflare's edge then has no origin and every request to alethialabs.io is a 502.
#
# That is not hypothetical: the #2747 promotion deployed at 06:27:08Z on 2026-08-26 and
# took the marketing site down. `caddy validate` passed, every container reported Started,
# the job went green, and the site had been 502 for minutes before anyone looked.
#
# Restarting cloudflared re-resolves the service name. It costs ~1s and is a no-op for
# correctness when caddy did not actually change.
docker compose $cf restart cloudflared
docker image prune -f
REMOTE

# DID THE SITE COME BACK? Nothing above answers that.
#
# Everything this job asserted up to here is about the box: images pulled, containers
# Started, and a Caddyfile whose SYNTAX is valid. None of it touches the path a visitor
# actually takes — edge → cloudflared → caddy → app — which is exactly the path the
# cloudflared/caddy ordering above used to break. A deploy that cannot tell a serving site
# from a dead one is not reporting on the deploy.
#
# Polled rather than probed once: containers legitimately take a few seconds to accept
# connections, so a single immediate curl would be flaky in the other direction. Ten
# attempts over ~100s is far longer than a healthy start and far shorter than a human
# noticing.
echo "Verifying ${APP_URL} actually serves..."
# `served` is the verdict and `last` is the evidence, deliberately two variables. Folding
# them into one (reset the code to 000 before each retry, then test it at the end) reports
# 000 for every failure — and 000 (nothing answered) points somewhere completely different
# from 502 (the edge answered, the origin did not). Losing that distinction in the one
# message an operator reads at 3am would repeat this incident's actual problem: an output
# that is technically emitted and tells you nothing.
served=0
last=000
for attempt in $(seq 1 10); do
  last="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$APP_URL/" || echo 000)"
  case "$last" in
    2*|3*) served=1; echo "✓ ${APP_URL} returned $last after ${attempt} attempt(s)"; break ;;
  esac
  echo "  attempt ${attempt}/10: HTTP ${last} — retrying in 10s"
  sleep 10
done
if [ "$served" -ne 1 ]; then
  echo "::error::Deploy finished but ${APP_URL} never served a 2xx/3xx (last HTTP ${last}). The"
  echo "::error::containers are up — suspect the tunnel: cloudflared holding a stale caddy address."
  echo "::group::compose ps"
  # The -f list is spelled out rather than reusing `$cf`: that variable is assigned inside
  # the <<'REMOTE' heredoc, which is QUOTED, so it exists only on the box and would expand
  # to empty here — leaving a `docker compose ps` that reads the base file alone and
  # cheerfully reports on the wrong set of services.
  ssh $SSHOPTS "root@${HOST}" 'cd /opt/alethia && docker compose \
    -f docker-compose.yml \
    -f deploy/prod/docker-compose.prod.yml \
    -f deploy/prod/docker-compose.tunnel.yml ps' || true
  echo "::endgroup::"
  exit 1
fi
