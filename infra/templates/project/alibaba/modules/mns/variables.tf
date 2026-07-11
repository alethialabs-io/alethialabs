# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "queues" {
  type        = map(any)
  default     = {}
  description = "Map of MNS queues to create, keyed by queue name"
}

variable "topics" {
  type        = map(any)
  default     = {}
  description = "Map of MNS topics to create, keyed by topic name"
}
