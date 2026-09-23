# COMMITTED ON PURPOSE — see infra/aws-oidc/terraform.tfvars for the precedent and #3108 for why
# every stack needed this.
#
# `e2e_github_environment` defaults to "", which drops the `env` federated credential from
# local.federated_subjects entirely (main.tf:42, consumed at main.tf:67). The credential map is
# never empty — the `ref` subject is unconditional — so nothing about the resource "disappears" in
# a way a plan summary makes obvious: one KEY goes missing, and every `workflow_dispatch` from
# `dev` then fails at federation. gcp-e2e has already shipped exactly this failure.
#
# subscription_id stays REQUIRED and is deliberately not here. e2e_monthly_budget_usd is not here
# either: its default of 100 has never been checked against the live Azure ceiling, and a committed
# number nobody has verified is a worse lie than a default.

e2e_github_environment = "e2e-dev"

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
