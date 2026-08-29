# COMMITTED ON PURPOSE — same treatment as infra/aws-oidc/terraform.tfvars, and for the same
# measured reason (#3108, following #3105).
#
# Every value here is already public: each is a repo Actions VARIABLE, readable by anyone with
# `gh variable list`, and the account id already appears in this repository at
# infra/connector-assets/bootstrap/variables.tf:33. Nothing secret lives here — `github_token` is
# deliberately absent, has no default, and is passed at apply time (`-var github_token=$(gh auth token)`).
#
# What its ABSENCE did. All three are `count`-gated in main.tf:161/168/175 on a variable defaulting
# to "", so on any checkout without this file a bare apply plans a DESTROY of:
#
#   CP_HETZNER_DEPLOYER_ROLE_ARN       -> infra-cp-hetzner.yml:63 stops federating
#   RUNNER_RELEASE_DEPLOYER_ROLE_ARN   -> the runner release loses OIDC
#   DEPLOY_READER_ROLE_ARN             -> deploy-console can no longer read AWS Secrets Manager
#
# README.md has carried a "never bare-apply" warning about exactly this since the stack was written.
# A warning is not a control, and there is an OUTSTANDING maintainer apply on this stack.
#
# Values read from the live repository on 2026-08-29 (`gh variable list`), not derived or typed.

cp_deployer_role_arn             = "arn:aws:iam::270587882865:role/alethia-cp-deployer"
runner_release_deployer_role_arn = "arn:aws:iam::270587882865:role/alethia-runner-release-deployer"
deploy_reader_role_arn           = "arn:aws:iam::270587882865:role/alethia-deploy-reader"
