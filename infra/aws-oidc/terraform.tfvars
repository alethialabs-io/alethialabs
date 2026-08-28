# COMMITTED ON PURPOSE. Every value here is already public (they are repo variables), and
# this file being gitignored is exactly what made a bare `tofu apply` dangerous: on a checkout
# without it, each variable fell back to a default that did NOT match the live account.
#
# Measured against the live account on 2026-08-28, the three below are the ones that mattered:
#   e2e_dns_zone_name       ""   -> planned the DESTRUCTION of a zone delegated at Cloudflare
#   e2e_github_environment  ""   -> narrowed the OIDC trust to ref-only, killing every
#                                   workflow_dispatch from `dev` at federation
#   e2e_monthly_budget_usd  100  -> silently doubled a ceiling the maintainer had set to 50
#
# The one input that CANNOT live here is e2e_budget_alert_emails: it holds personal addresses and
# this repo is public. It is a REQUIRED variable with no default, so a bare apply now fails loudly
# instead of silently unsubscribing the maintainer from their own cost alerts. Put it in the
# gitignored emails.auto.tfvars (see README).

github_repo   = "alethialabs-io/alethialabs"
github_branch = "main"

runner_aws_region     = "eu-west-1"
runner_ecr_repository = "alethia-runner-dev-runner"
runner_ecs_cluster    = "alethia-runner-dev-eu-west-1-cluster"
runner_ecs_service    = "alethia-runner-dev-eu-west-1-service"

# ---- E2E nightly provisioning role (BYOC A1.1) ----

# The nightly job pins `environment: e2e-dev`, whose deployment-branch policy is the single
# branch `dev`. Without this the trust is ref-only and no dispatch from `dev` can federate.
e2e_github_environment = "e2e-dev"

# Live zone Z0395392Z0SAB8SFGNLX. Also protected by `prevent_destroy` in e2e-dns.tf, because a
# comment saying "do not destroy this" is not a control.
e2e_dns_zone_name = "e2e.alethialabs.io"

e2e_monthly_budget_usd = 50
