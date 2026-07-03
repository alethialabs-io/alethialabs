<!--
SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# cp-gcp

GCP control-plane box running the Alethia control plane. One of the per-cloud `cp-*` siblings —
see [`infra/README.md`](../README.md).

- **Provider:** GCP. **State:** S3-compatible `terraform-state` · key `gcp-cp/terraform.tfstate`
  (custom endpoint — see `backend.hcl.example`).
- **CI auth:** static service-account JSON via `.github/workflows/infra-cp-gcp.yml`
  (`GOOGLE_CREDENTIALS`, `GCP_PROJECT` + `CLOUDFLARE_*`, `DEPLOY_SSH_PUBLIC_KEY`).

```bash
cp backend.hcl.example backend.hcl   # fill in endpoint + creds (gitignored)
cp terraform.tfvars.example terraform.tfvars
tofu init -backend-config=backend.hcl
tofu plan && tofu apply
```
