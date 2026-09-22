# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "region" {
  description = "The Alibaba region the state bucket lives in. MUST match the `region` in backend.hcl — the OSS backend derives its endpoint from that value, and a bucket in another region is simply not found there. Defaults to the e2e nightly's region so state and estate share a jurisdiction."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = can(regex("^[a-z]{2,}-[a-z]+-?[0-9]*$", var.region))
    error_message = "region must be a valid Alibaba region id (e.g. eu-central-1, cn-hangzhou, ap-southeast-1)."
  }
}

variable "state_bucket_name" {
  description = "Name of the OSS bucket holding the alibaba-e2e stacks' OpenTofu state. OSS bucket names are GLOBALLY unique, so change this if the default is taken. 3-63 chars, lowercase letters/digits/hyphens."
  type        = string
  default     = "alethia-tofu-state-e2e-alibaba"

  validation {
    # 3-58, not OSS's own 3-63. The access-log sink is named `<this>-logs` (main.tf) and has no
    # override of its own, so that derivation is provable at construction time only if this leaves
    # 5 characters of headroom. This variable IS the escape hatch for a taken `-logs` name too.
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,56}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be 3-58 characters of lowercase letters, digits and hyphens, not starting or ending with a hyphen — 5 short of OSS's 63, to leave room for the `-logs` access-log sink derived from it."
  }
}

variable "access_log_retention_days" {
  description = <<-EOT
    How long OSS access-log shards are kept in the sink bucket before the lifecycle rule deletes
    them. This is the forensic window for "who read or wrote the e2e state".

    90 days. An unauthorized read of this state shows up as its CONSEQUENCES — a RAM role whose
    trust policy moved, an OIDC provider that gained an audience — which surface weeks later, and a
    log that has already expired answers nothing. A quarter covers that gap.

    The bill is not the reason to tune this down: the stack is applied by hand a handful of times a
    year, so the sink holds kilobytes and 90 days of OSS Standard storage on it is a rounding error.
  EOT
  type        = number
  default     = 90

  validation {
    condition     = var.access_log_retention_days >= 30 && var.access_log_retention_days <= 3650
    error_message = "access_log_retention_days must be between 30 and 3650 — under 30 days is not a forensic window for a resource touched a few times a year."
  }
}
