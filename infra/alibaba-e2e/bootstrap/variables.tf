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
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be 3-63 characters of lowercase letters, digits and hyphens, not starting or ending with a hyphen."
  }
}
