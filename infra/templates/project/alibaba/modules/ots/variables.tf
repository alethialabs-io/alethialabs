# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "instance_name" {
  type        = string
  description = "Name of the Tablestore (OTS) instance"
}

variable "tables" {
  type        = list(any)
  default     = []
  description = "List of tables to create. Each entry: { name, primary_keys = [{ name, type }], time_to_live?, max_version? }"
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to the OTS instance"
}
