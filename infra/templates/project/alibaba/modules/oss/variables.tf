# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "buckets" {
  type        = list(any)
  default     = []
  description = "List of OSS buckets. Each entry: { name, acl?, storage_class?, versioning?, force_destroy? }"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to the buckets"
}
