<!--
SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# cp-hetzner

Hetzner Cloud control-plane box running the Alethia control plane. One of the per-cloud `cp-*`
siblings — see [`infra/README.md`](../README.md). (Distinct from `status/`, the separate Gatus
status-page VPS.)

- **Provider:** Hetzner Cloud (`hcloud`). **State:** S3-compatible `terraform-state` · key
  `hetzner/terraform.tfstate` (custom endpoint — see `backend.hcl.example`).
- **CI auth:** static keys via `.github/workflows/infra-cp-hetzner.yml` (`HCLOUD_TOKEN` +
  `TF_STATE_S3_ACCESS_KEY_ID` / `TF_STATE_S3_SECRET_ACCESS_KEY` for the state backend).

```bash
cp backend.hcl.example backend.hcl   # fill in endpoint + creds (gitignored)
cp terraform.tfvars.example terraform.tfvars
tofu init -backend-config=backend.hcl
tofu plan && tofu apply
```
