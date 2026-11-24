<!-- Moved out of the user docs (apps/docs, /self-host/terraform) by #5240: these are this repository's own deploy workflows, not a self-hoster's. -->

# Control-plane stacks in CI

## CI

Each stack has a workflow (`infra-cp-hetzner.yml`, `infra-cp-aws.yml`, `infra-cp-gcp.yml`,
`infra-cp-azure.yml`, `infra-cp-alibaba.yml`): the PR **`plan`** job runs `tofu validate` + fmt/tflint/
Trivy. Only `infra-cp-hetzner.yml` has an **`apply`** job, on push to `main` (prod runs on Hetzner).
`infra-cp-aws.yml`, `infra-cp-gcp.yml`, `infra-cp-azure.yml` and `infra-cp-alibaba.yml` are
**validate-only** — see below.

## Secrets per stack

### Hetzner — (`infra-cp-hetzner.yml`)
No GitHub secret. The `apply` job assumes the `alethia-cp-deployer` OIDC role
(`vars.CP_HETZNER_DEPLOYER_ROLE_ARN`), which authenticates the S3 state backend
(`alethia-tofu-state-…` · `hetzner/`) and reads `HCLOUD_TOKEN`, `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_ACCOUNT_ID` and `DEPLOY_SSH_PUBLIC_KEY` from AWS Secrets Manager.

### Aws — (`infra-cp-aws.yml`)
**None.** The workflow is validate-only and references no secret. `infra/cp-aws` is a self-hosting
option a user applies in their own account; it is not a deployment target of this repository. The
`apply` job it used to carry (behind `vars.INFRA_AWS_APPLY`, on static `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`) never ran and was removed on 2026-11-14. If AWS becomes a real target, add
a GitHub OIDC role to `infra/aws-oidc/roles.tf` (the `alethia-cp-deployer` pattern) and an
`aws-actions/configure-aws-credentials` apply job. Never reintroduce a static AWS key.

### Gcp — (`infra-cp-gcp.yml`)
**None.** The workflow is validate-only and references no secret. `infra/cp-gcp` is a self-hosting
option a user applies in their own project; it is not a deployment target of this repository. The
`apply` job it used to carry (behind `vars.INFRA_GCP_APPLY`, on a static `GOOGLE_CREDENTIALS` JSON
key) never applied anything and was removed on 2026-11-14. If GCP becomes a real target, add
Workload Identity Federation (the `infra/gcp-e2e` pattern) and a `google-github-actions/auth` apply
job. Never reintroduce a service-account key.

### Azure — (`infra-cp-azure.yml`)
**None.** The workflow is validate-only and references no secret. `infra/cp-azure` is a
self-hosting option a user applies in their own subscription; it is not a deployment target of this
repository. The `apply` job it used to carry (behind `vars.INFRA_AZURE_APPLY`, on a static
`ARM_CLIENT_SECRET`) never applied anything and was removed on 2026-11-14. If Azure becomes a real
target, add a federated identity credential (the `infra/azure-e2e` pattern) and an `azure/login`
apply job. Never reintroduce a client secret.

### Alibaba — (`infra-cp-alibaba.yml`)
**None.** The workflow is validate-only and references no secret. `infra/cp-alibaba` is a
self-hosting option a user applies in their own account; it is not a deployment target of this
repository. The `apply` job it used to carry (behind `vars.INFRA_ALIBABA_APPLY`, on a static
`ALICLOUD_ACCESS_KEY` / `ALICLOUD_SECRET_KEY`) never applied anything and was removed on 2026-11-14.
If Alibaba becomes a real target, add a RAM OIDC role (the `infra/alibaba-e2e` pattern) and an
`AssumeRoleWithOIDC` apply job. Never reintroduce a static AccessKey.
