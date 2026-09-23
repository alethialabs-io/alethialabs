# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "project_id" {
  description = "The DEDICATED e2e GCP project the state bucket lives in. MUST be the same project_id the parent infra/gcp-e2e stack is applied into — the state then sits inside the same blast radius as the identity it describes, exactly as aws-oidc's state sits in its own account."
  type        = string

  validation {
    # GCP's own rule: 6-30 characters, lowercase letter first, letters/digits/hyphens, no trailing
    # hyphen. Enforced here because `local.state_bucket_name` is DERIVED from it (see main.tf) and a
    # derived name has to be provably inside the target's length cap at construction time, not
    # discovered at apply time.
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid GCP project id: 6-30 chars, starting with a lowercase letter, containing only lowercase letters, digits and hyphens, not ending in a hyphen."
  }
}

variable "region" {
  description = "Provider region. Only used to home the provider; the bucket's placement is set by var.location."
  type        = string
  default     = "europe-west3"
}

variable "location" {
  description = "Bucket location. A multi-region (EU / US) or a region (europe-west3). Keep it in the same jurisdiction as the e2e project; the state is small, so multi-region costs nothing meaningful and survives a single-region outage."
  type        = string
  default     = "EU"
}

variable "state_bucket_name" {
  description = "Override the state bucket name. Empty = derive `alethia-tofu-state-<project_id>` (the GCS analogue of aws-oidc's `alethia-tofu-state-<account-id>`). GCS bucket names are GLOBALLY unique, so set this if the derived name is already taken."
  type        = string
  default     = ""

  validation {
    # 3-58, not GCS's own 3-63. The access-log sink is named `<this>-logs` (main.tf) and has no
    # override of its own, so that derivation is provable at construction time only if this leaves
    # 5 characters of headroom. The derived form caps at 49, so the bound binds only on an
    # explicit override — and this variable IS the escape hatch for a taken `-logs` name too.
    condition     = var.state_bucket_name == "" || can(regex("^[a-z0-9][a-z0-9._-]{1,56}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be empty (derive it) or a valid GCS bucket name of 3-58 characters — 5 short of GCS's 63, to leave room for the `-logs` access-log sink derived from it."
  }
}

variable "access_log_retention_days" {
  description = <<-EOT
    How long GCS usage-log shards are kept in the sink bucket before the lifecycle rule deletes
    them. This is the forensic window for "who read or wrote the e2e state".

    90 rather than the 30 used for state generations, and the difference is deliberate. 30 is sized
    for "I broke the state this week and want the previous generation"; an access question is not
    noticed that way. An unauthorized read of this state shows up as its CONSEQUENCES — an
    unexpected apply, an identity that moved — which surface weeks later, and a log that has
    already expired answers nothing. A quarter is long enough to cover that gap.

    The bill is not the reason to tune this down. The stacks are applied by hand a handful of times
    a year, so the sink holds kilobytes; at GCS Standard EU pricing 90 days of it is a rounding
    error against the state bucket itself. Raise it if you want a longer audit window.
  EOT
  type        = number
  default     = 90

  validation {
    condition     = var.access_log_retention_days >= 30 && var.access_log_retention_days <= 3650
    error_message = "access_log_retention_days must be between 30 and 3650 — under 30 days is not a forensic window for a resource touched a few times a year."
  }
}

variable "noncurrent_state_versions_kept" {
  description = "How many superseded state generations the bucket keeps. Versioning is the whole point of this bucket — this only stops it growing without bound. 30 is far more history than any recovery has ever needed."
  type        = number
  default     = 30

  validation {
    condition     = var.noncurrent_state_versions_kept >= 5
    error_message = "noncurrent_state_versions_kept must be >= 5 — fewer generations than that is not a recovery window."
  }
}
