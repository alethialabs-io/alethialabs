# COMMITTED ON PURPOSE — the same treatment as infra/aws-oidc/terraform.tfvars (#3105), applied
# here because this stack is where the defect was first MEASURED (#3108).
#
# `e2e_github_environment` defaults to "", and that default is not neutral: it drops the
# `assertion.sub` disjunct from the WIF attribute condition, narrowing the trust to ref-only. The
# scheduled nightly (which federates by ref on `main`) keeps working, so nothing looks broken —
# while every `workflow_dispatch` from `dev` dies at *Configure GCP credentials*. That has already
# happened once, from an apply that passed project_id and billing_account_id and nothing else.
#
# The value is public: `e2e-dev` is a GitHub environment name, and it is safe ONLY because that
# environment has a single deployment-branch policy (`dev`). It ADDS a subject; it never replaces
# the ref.
#
# project_id and billing_account_id stay REQUIRED and are deliberately NOT here — the first is the
# throwaway project this must never be applied outside, and both already fail loudly when absent.
# e2e_monthly_budget_usd is also absent: its default of 100 may or may not match the live ceiling,
# and committing a number nobody has checked against the billing account would be worse than the
# default, not better.

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
