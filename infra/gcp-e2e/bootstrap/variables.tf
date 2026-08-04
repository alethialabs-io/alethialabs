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
    condition     = var.state_bucket_name == "" || can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be empty (derive it) or a valid GCS bucket name of 3-63 characters."
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
