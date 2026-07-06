<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# cp-alibaba

Alibaba Cloud control-plane box running the Alethia control plane. One of the per-cloud `cp-*`
siblings — see [`infra/README.md`](../README.md).

- **Provider:** Alibaba Cloud. **State:** S3-compatible `terraform-state` · key
  `alibaba-cp/terraform.tfstate` (custom endpoint — see `backend.hcl.example`).
- **CI auth:** static keys via `.github/workflows/infra-cp-alibaba.yml`
  (`ALICLOUD_ACCESS_KEY` / `ALICLOUD_SECRET_KEY` + `CLOUDFLARE_*`, `DEPLOY_SSH_PUBLIC_KEY`).

```bash
cp backend.hcl.example backend.hcl   # fill in endpoint + creds (gitignored)
cp terraform.tfvars.example terraform.tfvars
tofu init -backend-config=backend.hcl
tofu plan && tofu apply
```
