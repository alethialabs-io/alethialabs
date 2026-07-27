# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

terraform {
  required_version = ">= 1.10"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.40"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Local state, deliberately. Unlike infra/cp-hetzner (S3 + OIDC, applied by CI),
  # this is a single developer's dev box applied from a laptop — an S3 backend would
  # add an AWS dependency to `pnpm env:up` for no benefit. The state file is
  # gitignored; losing it costs one `tofu import` of the server, not any data (the
  # envs themselves live in the box's snapshot, not in state).
}
