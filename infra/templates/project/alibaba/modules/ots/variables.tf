# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "instance_name" {
  type        = string
  description = "Name of the Tablestore (OTS) instance"
}

variable "tables" {
  type = list(object({
    name = string
    primary_keys = list(object({
      name = string
      type = string
    }))
    time_to_live = optional(number, -1)
    max_version  = optional(number, 1)
  }))
  default     = []
  description = <<-EOT
    Tablestore tables to create.

    TYPED, not `list(any)`, and that is the fix for #1836. The provider used to emit a scalar
    `primary_key` while this module read `try(each.value.primary_keys, [{ name = "id", type =
    "String" }])`, so `try` swallowed the miss and every table was silently built on the fallback
    key `id`/`String` instead of the partition key the user picked. Under `any` that is a clean
    plan; under this object type a caller that sends the wrong name fails the plan instead.
  EOT
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to the OTS instance"
}
