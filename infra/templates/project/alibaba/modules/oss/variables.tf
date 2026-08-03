# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

variable "name_prefix" {
  type        = string
  description = "Project-and-environment prefix the bucket names are composed from"
}

# TYPED ON PURPOSE, and this is the half that stops #1834 coming back.
#
# This was `list(any)`, which declares no fields at all: the module read `b.name` while the provider
# emitted `name_suffix`, and nothing in the repo could see the mismatch until a real plan blew up
# with "This object does not have an attribute named name". An object type turns that class of drift
# from a silent runtime failure into a loud declaration error at plan time, and it is what lets the
# offer-parity guard measure the DECLARE half of a switch at all — an `any` carrier is unmeasurable,
# so those cells are judged on the resource read alone.
#
# Every key the provider emits is named here, not just the ones this module reads. Two reasons: an
# object type silently DISCARDS attributes it does not declare, so an undeclared key is a drop with
# no evidence; and a partial type would make the guard start accusing the sibling switches that
# travel on the same variable (`acl` carries bucket:public_access, `versioning` carries
# bucket:versioning) of being undeclared — cells this change does not own.
variable "buckets" {
  type = list(object({
    name_suffix   = string
    acl           = optional(string, "private")
    storage_class = optional(string, "Standard")
    versioning    = optional(bool, false)
    force_destroy = optional(bool, false)
    # "None" means no default encryption rule — OSS's own spelling, and the position a bucket is in
    # when nobody asks. It is NOT a synonym for "encrypted by default"; OSS has no such default.
    sse_algorithm = optional(string, "None")
    # Emitted by the provider and accepted here so the declaration tells the truth about the wire.
    # This module does not implement CORS on OSS yet — declared-and-unread is deliberate and visible,
    # which is the point of declaring it rather than letting the object type drop it silently.
    cors_origins = optional(list(string), [])
  }))
  default = []
  # The allow-list for sse_algorithm is enforced on the ROOT `oss_buckets` variable rather than here,
  # because `tofu test`'s expect_failures can only address root-module checkables — a validation on a
  # module-nested variable is real but unprovable, and an unproven guard is how a non-guard ships.
  description = "List of OSS buckets. The real bucket name is name_prefix-name_suffix; OSS bucket names are globally unique across all of Alibaba Cloud, so the prefix is load-bearing, not cosmetic."
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to the buckets"
}
