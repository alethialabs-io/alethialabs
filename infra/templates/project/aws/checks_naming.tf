# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# NAMING-004 — derived ElastiCache identifiers that must fit a hard API cap.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new naming derivations for THIS feature here; never append to checks.tf.

locals {
  # Every name below is built from the same stem, which is `local.resource_tag` inside
  # modules/redis reproduced BYTE-FOR-BYTE at the root:
  #
  #   modules/redis/locals.tf:31
  #     resource_tag = format("%s-%s-%s", aws_regions_short[var.aws_region], var.environment, var.product_name)
  #
  # and the module is called with aws_region = var.region and product_name = var.project_name
  # (elasticache.tf), so the two expressions are the same string. The stem MUST stay identical:
  # every name that exists today is composed from it, and a name that changes forces REPLACEMENT
  # of the cache, its user group and its users.
  aws_redis_stem = "${local.aws_regions_short[var.region]}-${var.environment}-${var.project_name}"

  # ── The cap ──
  #
  # ElastiCache's CreateReplicationGroup API reference states the ReplicationGroupId constraints
  # verbatim:
  #
  #   A name must contain from 1 to 40 alphanumeric characters or hyphens.
  #   The first character must be a letter.
  #   A name cannot end with a hyphen or contain two consecutive hyphens.
  #
  # That 40 is quoted. The other three names here are RBAC identifiers (UserId, UserGroupId), and
  # AWS documents for those only "Length Constraints: Minimum length of 1" plus the pattern
  # `[a-zA-Z][a-zA-Z0-9\-]*` — no maximum at all. The terraform provider validates neither
  # (`internal/service/elasticache/user.go` carries no ValidateFunc on user_id). So 40 here is
  # ADOPTED as the shared ElastiCache identifier budget, not quoted for those three: it is the only
  # documented number on the surface, and a budget that is too tight costs readability above 40
  # while a budget that is too loose costs a failed apply. Erring tight is the cheap direction.
  aws_redis_name_max = 40

  # ── The four names ──
  #
  # None of these overflows on today's inputs, which is exactly why they are worth fixing now: the
  # two that DID overflow (#1873 Azure Key Vault, #1884 Alibaba Tablestore) were the same shape and
  # were only noticed when a nightly went red. The e2e nightly renders, with region us-east-1
  # ("ue1"), environment "<run_id>-<attempt>" (13 characters) and project_name "alethia-nl":
  #
  #   redis_name             "redis-ue1-30790581805-1-alethia-nl"          34 / 40
  #   redis_user_name        "redis-ue1-30790581805-1-alethia-nl"          34 / 40
  #   redis_user_group_name  "ue1-30790581805-1-alethia-nl"                28 / 40
  #   redis_default_user_id  "restricted-30790581805-1-default-user"       37 / 40   ← three chars
  #
  # `redis_default_user_id` is the one to look at. Three characters is not headroom, it is a
  # coincidence — the same margin `cr_name` has on alibaba (#1886). A GitHub run id is 11 digits
  # today and only grows, and `aws_elasticache_user_name` is a variable a caller can set.
  #
  # `redis_name` and `redis_user_name` are byte-identical today: the module composes them with two
  # separate format() calls that happen to agree. They are kept as two derivations here rather than
  # one alias, so that changing either composition later cannot silently move the other.
  #
  # Composed here rather than in the module for the reason NAMING-001/002/003 all give: a local
  # inside a module is unreachable from `tofu test`, which runs only against ./*.tftest.hcl in the
  # cloud root (.github/workflows/infra-templates.yml). At the root these are plain string
  # arithmetic over variables, decided before any resource exists. The module takes the finished
  # names as inputs.
  aws_redis_name_full            = "redis-${local.aws_redis_stem}"
  aws_redis_user_name_full       = "redis-${local.aws_redis_stem}"
  aws_redis_user_group_name_full = local.aws_redis_stem
  aws_redis_default_user_id_full = "restricted-${var.environment}-${var.aws_elasticache_user_name}-user"

  # The fallback, applied identically to all four: keep the readable form whenever it fits, and
  # otherwise truncate to 32 and append a 7-character digest OF THE FULL NAME (32 + "-" + 7 = 40).
  #
  # Digesting the full name rather than the truncated stem is what stops two environments sharing a
  # 32-character prefix from resolving to ONE replication group — two consecutive nightly runs are
  # precisely that shape, and a collision there is not a rename, it is two environments sharing a
  # cache.
  #
  # Trailing hyphens are stripped with a regex rather than `trimsuffix` so a truncation landing in
  # the middle of a hyphen run cannot leave one behind: ElastiCache rejects a name ending in a
  # hyphen, and would also reject the "--" that a naive join could produce.
  #
  # Backward-compatible by construction: the fallback is only reachable above 40 characters, which
  # is where ElastiCache refuses the name anyway. Every identifier that exists today keeps its
  # bytes.
  #
  # Written out four times rather than factored into a shared helper, deliberately: this mirrors the
  # three derivations already shipped (gcp gke_node_pool_name, azure azure_key_vault_name, alibaba
  # ots_name) line for line, and every one of the four is independently readable at the point of
  # use. checks_naming.tftest.hcl pins all four against literal expected values, which is what
  # actually catches an off-by-one — a shared helper would only move where the mistake could hide.
  aws_redis_name = (
    length(local.aws_redis_name_full) <= local.aws_redis_name_max
    ? local.aws_redis_name_full
    : format(
      "%s-%s",
      replace(substr(local.aws_redis_name_full, 0, 32), "/-+$/", ""),
      substr(sha256(local.aws_redis_name_full), 0, 7),
    )
  )

  aws_redis_user_name = (
    length(local.aws_redis_user_name_full) <= local.aws_redis_name_max
    ? local.aws_redis_user_name_full
    : format(
      "%s-%s",
      replace(substr(local.aws_redis_user_name_full, 0, 32), "/-+$/", ""),
      substr(sha256(local.aws_redis_user_name_full), 0, 7),
    )
  )

  aws_redis_user_group_name = (
    length(local.aws_redis_user_group_name_full) <= local.aws_redis_name_max
    ? local.aws_redis_user_group_name_full
    : format(
      "%s-%s",
      replace(substr(local.aws_redis_user_group_name_full, 0, 32), "/-+$/", ""),
      substr(sha256(local.aws_redis_user_group_name_full), 0, 7),
    )
  )

  aws_redis_default_user_id = (
    length(local.aws_redis_default_user_id_full) <= local.aws_redis_name_max
    ? local.aws_redis_default_user_id_full
    : format(
      "%s-%s",
      replace(substr(local.aws_redis_default_user_id_full, 0, 32), "/-+$/", ""),
      substr(sha256(local.aws_redis_default_user_id_full), 0, 7),
    )
  )

  aws_redis_derived_names = [
    local.aws_redis_name,
    local.aws_redis_user_name,
    local.aws_redis_user_group_name,
    local.aws_redis_default_user_id,
  ]
}

# Assert the OUTPUT of the derivation, not its input. The Azure twin of this asserted the input for
# months, warned on every run, and let the plan fail anyway (#1873) — a `check` block only WARNS, so
# an assertion over something that can still overflow buys nothing. Here the value can no longer
# overflow by construction, and this catches an arithmetic regression in the fallback itself.
#
# No terraform_data precondition, for the same reason as NAMING-002: there is nothing left that can
# overflow, so a hard gate could only fire on a bug in the lines above — and checks_naming.tftest.hcl
# catches that on every PR under mocked providers, where a precondition would need a real plan.
check "elasticache_names_within_limit" {
  assert {
    condition = alltrue([
      for n in local.aws_redis_derived_names : length(n) >= 1 && length(n) <= local.aws_redis_name_max
    ])
    error_message = "NAMING-004: a derived ElastiCache identifier is outside the 1-${local.aws_redis_name_max} range — ${jsonencode(local.aws_redis_derived_names)}. The truncate-plus-digest fallback in checks_naming.tf is wrong."
  }
}

# ElastiCache also requires every one of these to START WITH A LETTER, contain only alphanumerics
# and hyphens, and neither end with a hyphen nor contain two consecutive hyphens. The digest
# fallback satisfies all of those by construction; the readable forms inherit whatever
# project_name / environment / aws_elasticache_user_name carry, so an input with an underscore, a
# leading digit or a doubled hyphen produces a name AWS refuses. That is an input problem, and this
# says so at plan time instead of at apply.
check "elasticache_names_shape" {
  assert {
    condition = alltrue([
      for n in local.aws_redis_derived_names : can(regex("^[a-zA-Z][a-zA-Z0-9-]*[a-zA-Z0-9]$", n)) && !can(regex("--", n))
    ])
    error_message = "NAMING-004: a derived ElastiCache identifier must start with a letter, contain only letters/digits/hyphens, not end with a hyphen and not contain two consecutive hyphens — ${jsonencode(local.aws_redis_derived_names)}. Check project_name, environment and aws_elasticache_user_name."
  }
}
