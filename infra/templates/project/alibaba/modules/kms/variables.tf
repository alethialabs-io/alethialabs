# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "name_prefix" {
  type        = string
  description = "Prefix applied to every secret name"
}

variable "secrets" {
  type        = list(any)
  default     = []
  description = "List of secrets. Each entry: { name, generate?, length?, special_chars?, value? }"
}

variable "secret_keepers" {
  type        = map(map(string))
  default     = {}
  description = "Per-secret rotation keepers, keyed by secret name. Changing any value under a name re-generates that secret's password; a name absent from the map keeps its value forever. Empty is behavior-preserving."
}
