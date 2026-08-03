# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "instance_name" {
  type        = string
  description = "Name of the Container Registry Enterprise Edition instance"
}

variable "namespace_name" {
  type        = string
  description = "Name of the registry namespace to create"
}

# TYPED, unlike this template's other collection inputs. Most alibaba modules take list(any)/map(any)
# and read through `try(each.value.x, default)`, so an emitter can misspell a key and the plan is
# silently identical — and the offer-parity guard cannot read the declaration half of such a variable
# at all, which leaves a switch travelling on it judged on the resource argument alone. Naming the
# attributes makes a misspelling a plan error and makes `immutable_tags` measurable from both ends.
variable "repos" {
  type = map(object({
    summary        = optional(string, "")
    immutable_tags = optional(bool, true)
  }))
  default     = {}
  description = "Repositories to create inside the namespace, keyed by the registry component's name."
}
