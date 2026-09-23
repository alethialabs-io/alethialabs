# COMMITTED ON PURPOSE — see infra/aws-oidc/terraform.tfvars for the precedent (#3105) and #3108
# for why every stack needed the same treatment.
#
# `e2e_github_environment` is the fourth cloud to get this value. Its "" default drops the
# `environment:e2e-dev` subject from the OIDC trust, leaving it ref-only: the scheduled nightly
# survives and every `workflow_dispatch` from `dev` dies at federation. gcp-e2e has already shipped
# that exact failure, so aws-oidc, gcp-e2e, azure-e2e and this stack now all carry the value rather
# than three of four.
#
# `account_id` turns a check that could only ever PASS into one that can fail. checks.tf reads
# `var.account_id == "" || current == var.account_id`, so on the default the "applied in the
# expected account" pin is vacuously true — a safety check satisfied by the absence of its own
# input. The id is already public in this repository (docs/testing/cloud-preflight-2026-08-24.md)
# and is corroborated by the live repo variable E2E_ALIBABA_ROLE_ARN, which names the same account.
#
# `prod_regions` is deliberately still empty and is recorded in infra/tfvars-safety-baseline.json:
# there is no Alibaba production estate for an e2e region to collide with yet.

e2e_github_environment = "e2e-dev"
account_id             = "5767983785483306"

# ---- E2E assertion broker trust (#4226) ----
# The broker's origin, chosen by the maintainer on 2026-09-23: the Cloudflare custom domain that
# infra/e2e-issuer binds to the Worker. It must equal that stack's `hostname` byte for byte, and
# `node scripts/ci/check-e2e-issuer-health.mjs --static` (ci.yml) fails the PR that lets the copies
# drift. Committed here, never passed with -var at apply time: the next bare apply would read the old
# value and rewrite or REMOVE the trust.
#
# Committing it is inert until someone applies this stack, and that apply must come LAST — after the
# issuer serves at this origin (infra/e2e-issuer/README.md, the runbook). Any apply of this stack from
# here on creates the broker trust, so an unrelated apply must wait for the issuer too, or set this
# back to null in the same reviewed PR. See docs/testing/e2e-federation-apply-runbook.md.
e2e_broker_issuer_url = "https://e2e-issuer.alethialabs.io"
