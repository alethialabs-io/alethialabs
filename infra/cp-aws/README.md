<!--
SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# cp-aws

AWS control-plane box (single EC2 Graviton instance + security group + EIP) running the Alethia
control plane. One of the per-cloud `cp-*` siblings — see [`infra/README.md`](../README.md).

- **Provider:** AWS. **State:** S3-compatible `terraform-state` · key `aws-cp/terraform.tfstate`
  (custom endpoint — see `backend.hcl.example`).
- **CI auth:** static keys via `.github/workflows/infra-cp-aws.yml` (`AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` + `CLOUDFLARE_*`, `DEPLOY_SSH_PUBLIC_KEY`).

```bash
cp backend.hcl.example backend.hcl   # fill in endpoint + creds (gitignored)
cp terraform.tfvars.example terraform.tfvars
tofu init -backend-config=backend.hcl
tofu plan && tofu apply
```
