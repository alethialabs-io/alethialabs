# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# NAMING-002 — derived Azure resource names that must fit a hard API cap.
# Split out of checks.tf so each feature owns its file (IaC rule: one file per component).
# Add new naming derivations for THIS feature here; never append to checks.tf.

locals {
  # ── Key Vault: the tightest name limit on the whole Azure surface, 3-24 characters ──
  #
  # The readable form is "<project_name>-<environment>-kv", and it has NO length budget. The e2e
  # nightly renders:
  #
  #   alethia-nl  -  30829641000-1  -  kv    =  27 characters
  #      10              13            3
  #
  # which Azure refuses at PLAN time, before a single resource is created:
  #
  #   Error: "name" may only contain alphanumeric characters and dashes and must be between 3-24
  #   chars  (modules/key-vault/main.tf line 7)
  #
  # No fixture tuning fixes this. A GitHub run id is 11 digits today and only grows, so the
  # environment alone is 13 characters and the suffix is 3 — leaving 8 for the project name, which
  # no realistic customer name fits. And Key Vault is not optional: it is where the Azure secrets
  # live, and checks.tf requires a vault_uri whenever AKS is up.
  #
  # A `check` block for exactly this already existed and did nothing, because `check` only ever
  # WARNS — the plan still failed on azurerm's own validation. That is the #1716 lesson repeated on
  # another cloud: a name with no headroom has to be solved by CONSTRUCTION, not by assertion.
  #
  # So derive it defensively, the same way gcp/checks_naming.tf derives gke_node_pool_name: keep the
  # readable form whenever it fits, and otherwise fall back to a deterministic truncate-plus-digest
  # of at most 24 characters (16 + "-" + 7). Digesting the FULL name rather than the truncated stem
  # is what stops two environments sharing a 16-character prefix from colliding on one vault —
  # silent truncation without a digest would be worse than the bug, because two environments would
  # race for the same vault and quietly share secrets.
  #
  # Backward-compatible by construction: the fallback only triggers above 24 characters, which is
  # exactly where Azure refuses to create the vault at all. No vault that exists today can change
  # name — and a rename would force replacement of the store holding the environment's secrets.
  #
  # Trailing dashes are stripped with a regex rather than `trimsuffix` so a truncation landing on
  # "--" cannot leave one behind: Azure also rejects a name ending in a dash.
  azure_key_vault_name_max  = 24
  azure_key_vault_name_full = "${var.project_name}-${var.environment}-kv"
  azure_key_vault_name = (
    length(local.azure_key_vault_name_full) <= local.azure_key_vault_name_max
    ? local.azure_key_vault_name_full
    : format(
      "%s-%s",
      replace(substr(local.azure_key_vault_name_full, 0, 16), "/-+$/", ""),
      substr(sha256(local.azure_key_vault_name_full), 0, 7),
    )
  )
  azure_key_vault_name_len = length(local.azure_key_vault_name)

  ##############################################################################
  # The rest of the Azure surface (#1886)
  #
  # The Key Vault above is the one that FIRED. Auditing it turned up six more names with the
  # identical defect — composed from project_name + environment with no budget against a documented
  # cap. None of them fires on today's inputs, which is the only reason they are still here: every
  # one of these modules is opt-in (`create_storage_account`, `provision_acr`, `create_cosmos_db`,
  # `create_service_bus`, `create_azure_cache`, `azure_waf_enabled`), so they are exercised on the
  # Sunday full bar rather than the nightly floor — the same blind spot that hid #1884 for months.
  #
  # Every one of them is composed INSIDE its module. The readable form reproduced below is the
  # module's, byte for byte, and that matters more than it looks: this file's neighbour, locals.tf,
  # used to carry a parallel set of naming locals asserting a DIFFERENT convention
  # ("cosmos-<location_short>-<environment>-<project_name>") which nothing read. Adopting that form
  # here would have renamed — and therefore REPLACED — every Cosmos account, namespace, cache and
  # registry in existence. Those dead locals are deleted in the same change; these are the live ones.
  #
  # Caps are quoted from Microsoft's own naming rules
  # (learn.microsoft.com/azure/azure-resource-manager/management/resource-name-rules) except where
  # noted.
  ##############################################################################

  # ── Resource group: 1-90 characters ──
  #
  # Found by the tests rather than by the audit: an input long enough to overflow the four roomy
  # names below made azurerm reject the RESOURCE GROUP first, with
  #
  #   Error: "name" may not exceed 90 characters in length
  #
  # `rg-<project_name>-<environment>` in main.tf had no budget either, and it is the most
  # consequential name on the surface — every other Azure resource here is created inside it, so an
  # overflow does not fail one offer, it fails the entire deploy before anything exists.
  #
  # Renders 27 today, so there is a great deal of headroom. It is derived anyway: headroom is what
  # every one of these had until it did not.
  azure_resource_group_name_max  = 90
  azure_resource_group_name_full = "rg-${var.project_name}-${var.environment}"
  azure_resource_group_name = (
    length(local.azure_resource_group_name_full) <= local.azure_resource_group_name_max
    ? local.azure_resource_group_name_full
    : format(
      "%s-%s",
      replace(substr(local.azure_resource_group_name_full, 0, 82), "/-+$/", ""),
      substr(sha256(local.azure_resource_group_name_full), 0, 7),
    )
  )

  # ── Storage account: 3-24 characters, LOWERCASE LETTERS AND NUMBERS ONLY ──
  #
  # The tightest name on the Azure surface after the Key Vault, and tighter than anything #1886
  # listed. The e2e nightly renders:
  #
  #   alethianl  +  308293490951  +  st   =  23 characters
  #      9              12            2
  #
  # ONE character below the cap. A GitHub run id is 11 digits today; the next digit breaks this.
  #
  # Two shape fixes ride along, and both are no-ops for every account that can exist today:
  #
  #   * the strip widens from `-` to every non-alphanumeric. Azure permits nothing else here, so an
  #     account whose name needed a wider strip could never have been created.
  #   * `lower()` is applied. Uppercase is likewise invalid, so this cannot rename a live account —
  #     but it does stop a project_name like "AlethiaNL" from producing a name Azure refuses.
  #
  # The fallback joins with NO separator, unlike every other derivation here: a hyphen is not a legal
  # character in a storage account name. 16 + 8 hex = exactly 24, and hex is [0-9a-f], so the result
  # satisfies the alphabet by construction.
  azure_storage_account_name_max  = 24
  azure_storage_account_name_full = lower(replace("${var.project_name}${var.environment}st", "/[^a-zA-Z0-9]/", ""))
  azure_storage_account_name = (
    length(local.azure_storage_account_name_full) <= local.azure_storage_account_name_max
    ? local.azure_storage_account_name_full
    : format(
      "%s%s",
      substr(local.azure_storage_account_name_full, 0, 16),
      substr(sha256(local.azure_storage_account_name_full), 0, 8),
    )
  )

  # ── Container registry: 5-50 characters, alphanumerics ──
  #
  # Renders 24 today ("acr" + 9 + 12), so there is real headroom — but it is the same composition
  # with the same absent budget, and ACR is not optional for a customer using the native registry.
  #
  # `lower()` is deliberately NOT applied here, unlike the storage account: Azure permits uppercase
  # in a registry name, so lowercasing could rename a registry that legitimately exists. Only the
  # strip is widened, which cannot.
  azure_acr_name_max  = 50
  azure_acr_name_full = replace("acr${var.project_name}${var.environment}", "/[^a-zA-Z0-9]/", "")
  azure_acr_name = (
    length(local.azure_acr_name_full) <= local.azure_acr_name_max
    ? local.azure_acr_name_full
    : format(
      "%s%s",
      substr(local.azure_acr_name_full, 0, 42),
      substr(sha256(local.azure_acr_name_full), 0, 8),
    )
  )

  # ── Cosmos DB account: 3-44 characters, lowercase letters, numbers and hyphens ──
  #
  # Renders 31 today. Microsoft also requires the name to start with a lowercase letter or number,
  # which the readable form inherits from project_name — asserted below rather than silently fixed,
  # because normalising the first character would rename a live account.
  azure_cosmos_account_name_max  = 44
  azure_cosmos_account_name_full = "${var.project_name}-${var.environment}-cosmos"
  azure_cosmos_account_name = (
    length(local.azure_cosmos_account_name_full) <= local.azure_cosmos_account_name_max
    ? local.azure_cosmos_account_name_full
    : format(
      "%s-%s",
      replace(substr(local.azure_cosmos_account_name_full, 0, 36), "/-+$/", ""),
      substr(sha256(local.azure_cosmos_account_name_full), 0, 7),
    )
  )

  # ── Service Bus namespace: 6-50 characters, alphanumerics and hyphens ──
  #
  # Renders 27 today. Must start with a letter and end with a letter or number; the "sb-" prefix
  # satisfies the first by construction, and the fallback's trailing digest satisfies the second.
  azure_service_bus_name_max  = 50
  azure_service_bus_name_full = "sb-${var.project_name}-${var.environment}"
  azure_service_bus_name = (
    length(local.azure_service_bus_name_full) <= local.azure_service_bus_name_max
    ? local.azure_service_bus_name_full
    : format(
      "%s-%s",
      replace(substr(local.azure_service_bus_name_full, 0, 42), "/-+$/", ""),
      substr(sha256(local.azure_service_bus_name_full), 0, 7),
    )
  )

  # ── Azure Managed Redis: 1-60 characters ──
  #
  # NOT the 63 that Microsoft's naming-rules table gives for Microsoft.Cache/Redis. That entry
  # describes Azure Cache for Redis, which is RETIRING and which Azure now refuses to create — this
  # template moved the cache kind to `azurerm_managed_redis` (Microsoft.Cache/redisEnterprise), and
  # the ARM schema for that type states the constraint as a pattern rather than a range:
  #
  #   ^(?=.{1,60}$)[A-Za-z0-9]+(-[A-Za-z0-9]+)*$
  #
  # which is 60, not 63, and additionally forbids a leading hyphen, a trailing hyphen and any run of
  # two consecutive hyphens. Budgeting against the retired resource's 63 would have been wrong by
  # three characters in the dangerous direction.
  #
  # Renders 30 today.
  azure_cache_name_max  = 60
  azure_cache_name_full = "${var.project_name}-${var.environment}-redis"
  azure_cache_name = (
    length(local.azure_cache_name_full) <= local.azure_cache_name_max
    ? local.azure_cache_name_full
    : format(
      "%s-%s",
      replace(substr(local.azure_cache_name_full, 0, 52), "/-+$/", ""),
      substr(sha256(local.azure_cache_name_full), 0, 7),
    )
  )

  # ── WAF policy: 80 characters, ADOPTED not quoted ──
  #
  # Microsoft's naming-rules table does not list
  # Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies at all. It lists the sibling
  # `applicationGateways` — same provider, same resource-group scope, and the resource this policy
  # attaches to — at 1-80, and `frontdoorWebApplicationFirewallPolicies` at 1-128. 80 is taken from
  # the tighter of the two.
  #
  # Recorded as adopted rather than quoted because that is what it is. The cost of being wrong is
  # bounded and one-directional: the name renders 28 today, so the fallback is unreachable in
  # practice, and if the real cap turns out to be higher this only forgoes readability above 80.
  azure_waf_policy_name_max  = 80
  azure_waf_policy_name_full = "${var.project_name}-${var.environment}-waf"
  azure_waf_policy_name = (
    length(local.azure_waf_policy_name_full) <= local.azure_waf_policy_name_max
    ? local.azure_waf_policy_name_full
    : format(
      "%s-%s",
      replace(substr(local.azure_waf_policy_name_full, 0, 72), "/-+$/", ""),
      substr(sha256(local.azure_waf_policy_name_full), 0, 7),
    )
  )
}

# The derivation is only worth anything if it actually lands inside the cap. This asserts the OUTPUT,
# not the input — the old check asserted the input and let the plan fail anyway.
#
# Unlike NAMING-001 on gcp there is no terraform_data precondition here, and that is deliberate: this
# name can no longer overflow by construction, so a precondition could only fire on a bug in the
# arithmetic above. checks_naming.tftest.hcl is the right place to catch that, and it does — it runs
# on every PR under mocked providers, where a precondition would need a plan against real Azure.
check "key_vault_name_within_limit" {
  assert {
    condition     = local.azure_key_vault_name_len >= 3 && local.azure_key_vault_name_len <= local.azure_key_vault_name_max
    error_message = "NAMING-002: the derived Key Vault name '${local.azure_key_vault_name}' is ${local.azure_key_vault_name_len} chars, outside Azure's 3-${local.azure_key_vault_name_max} range. The truncate-plus-digest fallback in checks_naming.tf is wrong."
  }
}

# The remaining six, same reasoning: assert the OUTPUT of each derivation. Each one can no longer
# overflow by construction, so these fire only on an arithmetic regression in the lines above —
# which is exactly what checks_naming.tftest.hcl exists to catch on every PR, and what these state
# in the plan output of a real deploy.

check "resource_group_name_within_limit" {
  assert {
    condition     = length(local.azure_resource_group_name) >= 1 && length(local.azure_resource_group_name) <= local.azure_resource_group_name_max
    error_message = "NAMING-002: the derived resource group name '${local.azure_resource_group_name}' is ${length(local.azure_resource_group_name)} chars, over Azure's ${local.azure_resource_group_name_max}-character cap. Nothing in this template can be created without the resource group."
  }

  # Azure permits a wide alphabet here but rejects a name ending in a period.
  assert {
    condition     = !endswith(local.azure_resource_group_name, ".")
    error_message = "NAMING-002: the derived resource group name '${local.azure_resource_group_name}' must not end with a period."
  }
}

check "storage_account_name_within_limit" {
  assert {
    condition     = length(local.azure_storage_account_name) >= 3 && length(local.azure_storage_account_name) <= local.azure_storage_account_name_max
    error_message = "NAMING-002: the derived storage account name '${local.azure_storage_account_name}' is ${length(local.azure_storage_account_name)} chars, outside Azure's 3-${local.azure_storage_account_name_max} range."
  }

  # Storage accounts permit lowercase letters and numbers and nothing else — no hyphens, no
  # uppercase. The derivation lowercases and strips, so this fires only if that stopped working.
  assert {
    condition     = can(regex("^[a-z0-9]+$", local.azure_storage_account_name))
    error_message = "NAMING-002: the derived storage account name '${local.azure_storage_account_name}' must contain only lowercase letters and numbers."
  }
}

check "acr_name_within_limit" {
  assert {
    condition     = length(local.azure_acr_name) >= 5 && length(local.azure_acr_name) <= local.azure_acr_name_max
    error_message = "NAMING-002: the derived container registry name '${local.azure_acr_name}' is ${length(local.azure_acr_name)} chars, outside Azure's 5-${local.azure_acr_name_max} range."
  }

  assert {
    condition     = can(regex("^[a-zA-Z0-9]+$", local.azure_acr_name))
    error_message = "NAMING-002: the derived container registry name '${local.azure_acr_name}' must contain only alphanumerics."
  }
}

check "cosmos_account_name_within_limit" {
  assert {
    condition     = length(local.azure_cosmos_account_name) >= 3 && length(local.azure_cosmos_account_name) <= local.azure_cosmos_account_name_max
    error_message = "NAMING-002: the derived Cosmos DB account name '${local.azure_cosmos_account_name}' is ${length(local.azure_cosmos_account_name)} chars, outside Azure's 3-${local.azure_cosmos_account_name_max} range."
  }

  # Must start with a lowercase letter or number and carry only lowercase letters, numbers and
  # hyphens. The first character comes from project_name and is NOT normalised — normalising it
  # would rename a live account — so this is where a bad project_name is reported.
  assert {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*[a-z0-9]$", local.azure_cosmos_account_name))
    error_message = "NAMING-002: the derived Cosmos DB account name '${local.azure_cosmos_account_name}' must start with a lowercase letter or number, contain only lowercase letters/numbers/hyphens, and not end with a hyphen. Check project_name."
  }
}

check "service_bus_name_within_limit" {
  assert {
    condition     = length(local.azure_service_bus_name) >= 6 && length(local.azure_service_bus_name) <= local.azure_service_bus_name_max
    error_message = "NAMING-002: the derived Service Bus namespace '${local.azure_service_bus_name}' is ${length(local.azure_service_bus_name)} chars, outside Azure's 6-${local.azure_service_bus_name_max} range."
  }

  assert {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]*[a-zA-Z0-9]$", local.azure_service_bus_name))
    error_message = "NAMING-002: the derived Service Bus namespace '${local.azure_service_bus_name}' must start with a letter, contain only alphanumerics and hyphens, and end with a letter or number."
  }
}

check "azure_cache_name_within_limit" {
  assert {
    condition     = length(local.azure_cache_name) >= 1 && length(local.azure_cache_name) <= local.azure_cache_name_max
    error_message = "NAMING-002: the derived Managed Redis name '${local.azure_cache_name}' is ${length(local.azure_cache_name)} chars, over Microsoft.Cache/redisEnterprise's ${local.azure_cache_name_max}-character cap."
  }

  # The ARM schema states this as one pattern: hyphen-separated alphanumeric groups. That forbids a
  # leading hyphen, a trailing hyphen and any doubled hyphen in a single expression.
  assert {
    condition     = can(regex("^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$", local.azure_cache_name))
    error_message = "NAMING-002: the derived Managed Redis name '${local.azure_cache_name}' must match Microsoft.Cache/redisEnterprise's pattern — alphanumeric groups joined by single hyphens, no leading, trailing or doubled hyphen. Check project_name and environment."
  }
}

check "waf_policy_name_within_limit" {
  assert {
    condition     = length(local.azure_waf_policy_name) >= 1 && length(local.azure_waf_policy_name) <= local.azure_waf_policy_name_max
    error_message = "NAMING-002: the derived WAF policy name '${local.azure_waf_policy_name}' is ${length(local.azure_waf_policy_name)} chars, over the adopted ${local.azure_waf_policy_name_max}-character budget."
  }
}
