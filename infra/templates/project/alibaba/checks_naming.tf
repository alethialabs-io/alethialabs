# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# NAMING-003 — derived Alibaba resource names that must fit a hard API cap.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new naming derivations for THIS feature here; never append to checks.tf.

locals {
  # ── Tablestore (OTS): 3-16 characters, the tightest cap on the Alibaba surface ──
  #
  # From Alibaba's Tablestore naming conventions:
  #
  #   The name must be 3 to 16 characters in length.
  #   The name can contain only letters, digits, and hyphens (-).
  #   The name must start with a letter and cannot end with a hyphen (-).
  #   The name is case-insensitive.
  #
  # The composition was "ots<project_name><environment>" with hyphens stripped and no length budget
  # whatsoever. The e2e fixture renders:
  #
  #   ots + alethianl + 308296410001  =  24 characters
  #    3       9            12
  #
  # 24 > 16, so it cannot be created — and not just for the fixture: the environment alone is 12
  # characters after hyphen-stripping, which leaves ONE character for the project name. There is no
  # input for which the readable form is safe (#1884).
  #
  # It has never been seen to fail because create_ots is off on the nightly floor and on only for
  # the Sunday full bar — the run whose reds were deduped away against the floor's once already
  # (#1755).
  #
  # THE FALLBACK IS OPAQUE ON PURPOSE. Several sources state a Tablestore instance name may not
  # CONTAIN the words `ali`, `ay`, `ots`, `taobao` or `admin`. That is not on Alibaba's own
  # naming-conventions page, so it is reported rather than established — but a fallback that
  # truncates user-supplied text in cannot be shown safe against it either way (a project name like
  # "mayflower" carries "ay"). A hex digest can: hex is [0-9a-f], which contains none of the letters
  # in any of those words. So the fallback is "ts" + 12 hex = 14 characters, which also satisfies
  # start-with-a-letter and no-trailing-hyphen by construction, and is safe under that rule whether
  # or not it turns out to be real.
  #
  # The readable form is still kept WHEN IT FITS, for the usual reason: a rename destroys the store.
  # An instance created under a short project/environment must not move. Note this means a surviving
  # short name still begins with "ots" — if the reserved-word rule is real, such an instance could
  # never have been created in the first place, so there is nothing to protect and nothing to break.
  ots_name_max  = 16
  ots_name_full = replace("ots${var.project_name}${var.environment}", "-", "")
  ots_name = (
    length(local.ots_name_full) <= local.ots_name_max
    ? local.ots_name_full
    : format("ts%s", substr(sha256(local.ots_name_full), 0, 12))
  )
  ots_name_len = length(local.ots_name)

  # ── Container Registry Enterprise Edition instance: 30 characters, REPORTED not established ──
  #
  # `cr_name` was composed in locals.tf as `replace("cr-<project_name>-<environment>", "_", "-")`
  # with no budget. The e2e nightly renders:
  #
  #   cr-  +  alethia-nl  +  -  +  30829641000-1   =  27 characters
  #    3         10           1        13
  #
  # against a cap of 30. Three characters is not headroom, it is a coincidence — and a GitHub run id
  # is 11 digits today and only grows.
  #
  # THE CAP ITSELF IS UNCONFIRMED, and that is stated rather than hidden — same treatment as the
  # Tablestore reserved-word rule above. Alibaba's "Create a Container Registry Enterprise Edition
  # instance" page documents the field as "Instance name: Enter an instance name" and states no
  # length, no alphabet and no first-character rule; the aliyun provider's own
  # `alicloud_cr_ee_instance.instance_name` schema carries no ValidateFunc either. 30 is the figure
  # reported in #1886 and it is adopted here because a budget that is too tight costs readability
  # while a budget that is absent costs a failed apply, which is the position this composition is in
  # today.
  #
  # The readable form is kept whenever it fits, for the usual reason: `instance_name` is ForceNew on
  # this resource, so a rename DESTROYS AND RECREATES the registry — and with it every image pushed
  # to it. The fallback is reachable only above 30, where the current code would be gambling anyway.
  #
  # Unlike ots_name the fallback here is not opaque: the reserved-word concern that forced a bare
  # digest for Tablestore is a Tablestore rule, and "cr-" is already the prefix Alibaba's own
  # examples use. Truncate-plus-digest keeps the name legible.
  cr_name_max  = 30
  cr_name_full = replace("cr-${var.project_name}-${var.environment}", "_", "-")
  cr_name = (
    length(local.cr_name_full) <= local.cr_name_max
    ? local.cr_name_full
    : format(
      "%s-%s",
      replace(substr(local.cr_name_full, 0, 22), "/-+$/", ""),
      substr(sha256(local.cr_name_full), 0, 7),
    )
  )
  cr_name_len = length(local.cr_name)
}

# Assert the OUTPUT of the derivation, not its input. The Azure twin of this asserted the input for
# months, warned, and let the plan fail anyway (#1873) — `check` blocks only warn, so an assertion
# over something that can still overflow buys nothing. Here the value can no longer overflow by
# construction, and this catches an arithmetic regression in the fallback itself.
check "ots_instance_name_within_limit" {
  assert {
    condition     = local.ots_name_len >= 3 && local.ots_name_len <= local.ots_name_max
    error_message = "NAMING-003: the derived Tablestore instance name '${local.ots_name}' is ${local.ots_name_len} chars, outside Alibaba's 3-${local.ots_name_max} range. The truncate-plus-digest fallback in checks_naming.tf is wrong."
  }
}

# Tablestore also requires the name to START WITH A LETTER and not end with a hyphen. The digest
# fallback satisfies both by construction; the readable form inherits whatever project_name starts
# with, so a project name beginning with a digit would produce a name Alibaba refuses.
check "ots_instance_name_shape" {
  assert {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]*[a-zA-Z0-9]$", local.ots_name))
    error_message = "NAMING-003: the derived Tablestore instance name '${local.ots_name}' must start with a letter, contain only letters/digits/hyphens, and not end with a hyphen. Check project_name."
  }
}

# Same reasoning for the registry: assert the OUTPUT. This can no longer overflow by construction,
# so it fires only on an arithmetic regression in the fallback — which checks_naming.tftest.hcl
# catches on every PR, and which this states in the plan output of a real deploy.
check "cr_instance_name_within_limit" {
  assert {
    condition     = local.cr_name_len >= 3 && local.cr_name_len <= local.cr_name_max
    error_message = "NAMING-003: the derived Container Registry instance name '${local.cr_name}' is ${local.cr_name_len} chars, over the ${local.cr_name_max}-character budget. The truncate-plus-digest fallback in checks_naming.tf is wrong."
  }
}
