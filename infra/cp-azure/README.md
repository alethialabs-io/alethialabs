<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# cp-azure

Azure control-plane box running the Alethia control plane. One of the per-cloud `cp-*` siblings —
see [`infra/README.md`](../README.md).

- **Provider:** Azure. **State:** S3-compatible `terraform-state` · key
  `azure-cp/terraform.tfstate` (custom endpoint — see `backend.hcl.example`).
- **CI auth:** static service-principal via `.github/workflows/infra-cp-azure.yml`
  (`ARM_CLIENT_ID` / `ARM_CLIENT_SECRET` / `ARM_SUBSCRIPTION_ID` / `ARM_TENANT_ID` +
  `CLOUDFLARE_*`, `DEPLOY_SSH_PUBLIC_KEY`).

```bash
cp backend.hcl.example backend.hcl   # fill in endpoint + creds (gitignored)
cp terraform.tfvars.example terraform.tfvars
tofu init -backend-config=backend.hcl
tofu plan && tofu apply
```
