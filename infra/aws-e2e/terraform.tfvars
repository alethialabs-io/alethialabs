# COMMITTED ON PURPOSE (overriding infra/.gitignore; see .gitignore here). Every value is already
# public — Alethia's own account ids, repo variables, the zone name — and a missing file is what let
# infra/aws-oidc's bare apply fall back to defaults that did not match the live account.
#
# The one input that cannot live here is e2e_budget_alert_emails (personal addresses, public repo).
# It is REQUIRED; put it in the gitignored emails.auto.tfvars (see terraform.tfvars.example).

# The dedicated `alethia-e2e` member account (created 2026-11-14).
e2e_account_id = "556074788436"

# The Alethia platform account, named only so the boundary can deny its prod resources by ARN.
alethia_account_id = "270587882865"

github_repo       = "alethialabs-io/alethialabs"
e2e_github_branch = "main"

# The nightly job pins `environment: e2e-dev` (branch-restricted to `dev`). Same as infra/aws-oidc.
e2e_github_environment = "e2e-dev"

# The weekly spend report's environment (branch-restricted to `main`). Same as infra/aws-oidc's
# spend_reporter_environment: both reporters trust the one subject the report's job presents.
spend_reporter_environment = "spend-report"

# Same ceiling as the live infra/aws-oidc budget. It now covers the whole e2e account.
e2e_monthly_budget_usd = 50

# A second zone of this name, in the e2e account. Cloudflare's NS set decides which one answers.
e2e_dns_zone_name = "e2e.alethialabs.io"

# Must equal infra/e2e-issuer's hostname and every other trust stack's copy, byte for byte:
# `node scripts/ci/check-e2e-issuer-health.mjs --static` (ci.yml, always-run guards job) fails a PR
# that lets them drift.
e2e_broker_issuer_url = "https://e2e-issuer.alethialabs.io"
