<!-- Moved out of the user docs (apps/docs, /guides/self-hosting/terraform) by #5240: these are this repository's own deploy workflows, not a self-hoster's. -->

# Control-plane stacks in CI

## CI

Each stack has a workflow (`infra-cp-hetzner.yml`, `infra-cp-aws.yml`, `infra-cp-gcp.yml`,
`infra-cp-azure.yml`, `infra-cp-alibaba.yml`): the PR **`plan`** job runs `tofu validate` + fmt/tflint/
Trivy; the **`apply`** job is **gated off** behind `vars.INFRA_<CLOUD>_APPLY` (prod runs on Hetzner).

## Secrets per stack

### Hetzner — (`infra-cp-hetzner.yml`)
`HCLOUD_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_ACCOUNT_ID`,
`DEPLOY_SSH_PUBLIC_KEY`, `TF_STATE_S3_ENDPOINT|REGION|ACCESS_KEY_ID|SECRET_ACCESS_KEY`.

### Aws — (`infra-cp-aws.yml`)
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (provider), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`,
`CLOUDFLARE_ACCOUNT_ID`, and the `TF_STATE_S3_*` backend secrets. `apply` is gated behind
`vars.INFRA_AWS_APPLY`.

### Gcp — (`infra-cp-gcp.yml`)
`GOOGLE_CREDENTIALS` (SA JSON), `GCP_PROJECT`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`,
`CLOUDFLARE_ACCOUNT_ID`, and the `TF_STATE_S3_*` backend secrets. `apply` is gated behind
`vars.INFRA_GCP_APPLY`.

### Azure — (`infra-cp-azure.yml`)
`ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, `ARM_SUBSCRIPTION_ID`, `ARM_TENANT_ID` (service principal),
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_ACCOUNT_ID`, and the `TF_STATE_S3_*` backend
secrets. `apply` is gated behind `vars.INFRA_AZURE_APPLY`.

### Alibaba — (`infra-cp-alibaba.yml`)
`ALICLOUD_ACCESS_KEY`, `ALICLOUD_SECRET_KEY` (RAM key), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`,
`CLOUDFLARE_ACCOUNT_ID`, and the `TF_STATE_S3_*` backend secrets. `apply` is gated behind
`vars.INFRA_ALIBABA_APPLY`.
