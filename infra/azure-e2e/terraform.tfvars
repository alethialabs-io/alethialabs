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
