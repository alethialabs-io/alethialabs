# COMMITTED ON PURPOSE — see infra/aws-oidc/terraform.tfvars for the precedent (#3105) and
# infra/README.md "Inputs — a default is a decision". Every value here is public: the hostname IS the
# issuer origin four clouds trust.
#
# `cloudflare_account_id` is the one input NOT here: it is required and supplied at apply time
# (TF_VAR_cloudflare_account_id or a gitignored account.auto.tfvars). See README.md.
#
# `hostname` has four more copies that must agree with it byte-for-byte: `e2e_broker_issuer_url` in
# infra/{aws-oidc,gcp-e2e,azure-e2e,alibaba-e2e}/terraform.tfvars, and `issuer_url` in
# tls-ca-pin.json. `node scripts/ci/check-e2e-issuer-health.mjs --static` (ci.yml, the always-run
# `Authz / open-core guards` job — no path filter) fails the PR that
# lets them drift.

zone_name = "alethialabs.io"
hostname  = "e2e-issuer.alethialabs.io"
