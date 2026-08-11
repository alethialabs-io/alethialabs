<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Azure cache CIDR allow-list — can `caches.allowed_cidr_blocks` be expressed on any resource path we can actually build?

Research answer for **#2264**, which blocks **#2148** (`caches.allowed_cidr_blocks` on Azure —
part of the offer-parity epic #1419). Checked 2026-08-10.

Read against the provider version this repo actually resolves — `hashicorp/azurerm` **4.81.0**,
pinned at `infra/templates/project/azure/.terraform.lock.hcl:31` under the root constraint
`>= 3.0, < 5.0` (`infra/templates/project/azure/main.tf:8`) — and, because the answer must not
hinge on a constraint bump, re-probed against **5.0.1**, the newest major. Service-side facts come
from Microsoft's own product documentation and the repo's recorded apply behaviour. No secondary
write-ups.

---

## The three answers, up front

**Q1 — is classic `azurerm_redis_cache` (Microsoft.Cache/redis) truly refused for NEW creates?**
**Yes for the tenants that matter, and it is not a binary.** Since **April 1, 2026** Azure blocks
Basic/Standard/Premium creation for **new-customer tenants** (a tenant qualifies as "existing" only
if some subscription in it had a cache before that date); grandfathered tenants may keep creating
until the full retirement on **September 30, 2028**. Alethia provisions into *customer*
subscriptions, so the classic path would work for some tenants and return the recorded
`400 BadRequest` for others — a per-tenant lottery the template cannot resolve, with everything it
built dying in 2028 regardless. §2.

**Q2 — does Managed Redis (Microsoft.Cache/redisEnterprise) expose ANY CIDR-equivalent network
control on any ARM surface reachable from azurerm?**
**No.** The service's own security documentation lists exactly two network controls — Private Link
private endpoints and the `publicNetworkAccess` on/off switch — and no firewall/IP-rule feature
exists for Managed Redis anywhere in ARM. Network Security Perimeter, the one ARM mechanism whose
access rules take literal CIDR prefixes, has **no Microsoft.Cache resource type on its onboarded
list** (GA, list current as of 2026-07), so the generic `azurerm_network_security_perimeter_*`
resources present at both 4.81.0 and 5.0.1 have nothing of ours to associate. Provider probes at
both versions confirm no cache-scoped firewall resource. §3–§5.

**Q3 — decision:** **withdraw the control on Azure** (#1993 mechanics: `unavailableWhen` on the
canvas control + permanent `exclusions:` entry carrying this evidence). Every alternative fails a
concrete test, not a taste test. §6.

---

## 1. What the repo builds today, and the apply-grade evidence it already holds

- `infra/templates/project/azure/azure-cache-redis.tf` backs the cache kind with
  `azurerm_managed_redis` (Microsoft.Cache/redisEnterprise) via `modules/azure-cache-redis`.
- The module header records a **real apply refusal**, verbatim
  (`modules/azure-cache-redis/main.tf:4-7`):

  > `400 BadRequest: Azure Cache for Redis is retiring, create Azure Managed Redis instance
  > instead. Learn more: https://aka.ms/AzureCacheForRedisRetirement`

  That is first-party evidence that the tenants Alethia provisions hit the new-customer creation
  block — the strongest possible form of "refused for new creates" for *our* deployment shape.
- The module declares **no network surface at all**: `azurerm_managed_redis` with `sku_name`,
  `high_availability_enabled`, an inline `default_database`, and `tags`
  (`modules/azure-cache-redis/main.tf:23-40`).
- The #2148 probe (recorded in that issue's release comment, 2026-08-09) already established
  against 4.81.0: `azurerm_redis_firewall_rule` attaches only to classic `azurerm_redis_cache` by
  `redis_cache_name`; `azurerm_managed_redis` exposes no firewall/CIDR attribute; the only network
  knob is `public_network_access` (Enabled/Disabled). Re-confirmed in this pass, plus 5.0.1.

## 2. Q1 — the retirement, dated and scoped (Microsoft's own timeline)

Source: *What's New in Azure Cache for Redis*, the page `aka.ms/AzureCacheForRedisRetirement`
301-redirects to (`learn.microsoft.com/azure/azure-cache-for-redis/cache-whats-new`, retrieved
2026-08-10). Azure public cloud, Basic/Standard/Premium:

| Date | Fact |
| --- | --- |
| April 1, 2026 | Creating new caches is **blocked for new customers**. A tenant is an "existing customer" only if any of its subscriptions had an Azure Cache for Redis instance before April 1, 2026. |
| September 30, 2028 | **All** Basic/Standard/Premium caches are retired. |

Two qualifications that matter for the decision:

- The October 2026 creation block for *existing* customers was **removed** (July 2026 update) — so
  "classic is creatable" is genuinely true for grandfathered tenants until retirement. The refusal
  is **per-tenant**, not global.
- Enterprise/Enterprise Flash creation was blocked for everyone on April 1, 2026, and those tiers
  are force-migrated to Managed Redis on March 31, 2027 — so the classic *resource family* has no
  survivable branch.

**Why this kills the "switch back / dual-path" option anyway:** Alethia's provisioner cannot know
whether a customer tenant is grandfathered. A template that builds classic Redis plans cleanly
everywhere and applies successfully **only in tenants that happen to predate April 2026** — the
same plan, two outcomes, decided by a fact outside the config. That is a nondeterminism the
product cannot ship, and every cache it did manage to build would need forced migration by
September 2028. Dual-path (classic where possible, Managed Redis otherwise) inherits the same
undetectable tenant split *plus* two divergent output contracts for one kind.

## 3. Q2a — Managed Redis's own network surface (service-side)

Source: *Secure your Azure Managed Redis deployment*
(`learn.microsoft.com/azure/redis/secure-azure-managed-redis`, ms.date 2026-03-30, retrieved
2026-08-10). Its **Network security** section is exhaustive and contains exactly two controls:

1. **Private endpoints** (Azure Private Link) — "the recommended solution for securing your Azure
   Managed Redis resource at the networking layer."
2. **`publicNetworkAccess`** — disable public access when using private endpoints.

There is no firewall-rules feature, no IP-rules property, no `network_acls`-style block anywhere in
the Managed Redis documentation set. The "Firewall rules" feature referenced in Azure cache Q&A
belongs to the **classic** service (`Microsoft.Cache/redis/firewallRules`), which is precisely the
resource the retirement takes away.

## 4. Q2b — Network Security Perimeter: the one honest CIDR mechanism, and why it is out of reach

NSP is the ARM mechanism whose inbound access rules take literal IP prefixes — if
redisEnterprise supported it, a CIDR allow-list would be genuinely expressible. Both halves were
checked:

- **Provider half (present):** at pinned **4.81.0** *and* at **5.0.1**, azurerm ships
  `azurerm_network_security_perimeter`, `_profile`, `_access_rule`, `_association`. The access
  rule's schema (probed, not read from docs) takes `address_prefixes: list(string)` +
  `direction`; the association takes a generic `resource_id` + `access_mode`.
- **Service half (absent, and it is the half that decides):** the NSP concepts page
  (`learn.microsoft.com/azure/private-link/network-security-perimeter-concepts`, updated
  2026-07-22, feature GA) enumerates the **onboarded private-link resources** — Azure Monitor,
  AI Search, Cosmos DB, Event Hubs, Key Vault, SQL DB, Storage, Azure OpenAI, Foundry, Service
  Bus. **No Microsoft.Cache type appears — neither classic redis nor redisEnterprise.**

So an `azurerm_network_security_perimeter_association` pointed at a Managed Redis id targets a
resource type the service does not support: it fails at apply, or — worse, the carriage guard's
named trap — creates an association that *looks* like an allow-list while the cache keeps
answering public traffic. The provider resources existing is exactly the "looks equivalent, gates
nothing" hazard, not a carrier.

## 5. Q2c — private endpoints cannot carry a CIDR list, and `public_network_access` cannot either

- A private endpoint is **VNet-scoped**: it grants reachability to a network you attach, not to an
  IP range you name. `caches.allowed_cidr_blocks` is a list of source prefixes; there is no
  honest function from that list to a set of private endpoints. Wiring one to the other would
  satisfy the guard's "a resource argument reads the tfvar" test while implementing a different
  feature — the #1838 Synapse shape, on the network axis.
- `public_network_access` is an on/off switch. Deriving it from the list (e.g. "any CIDR present →
  Enabled") discards every address the user typed — the #1993 `num_cache_nodes` shape, where the
  value decided something and the *number* was still discarded.

Both are explicitly ruled out as carriers, per the carriage guard's own warning history.

## 6. Decision matrix

| Option | Verdict | Why |
| --- | --- | --- |
| 1. Switch back / dual-path to classic + `azurerm_redis_firewall_rule` | **Refused** | Per-tenant creation lottery since 2026-04-01 (provisioner cannot detect grandfathering; repo's own apply already hit the 400); full retirement 2028-09-30; dual-path adds a second output contract for one kind. |
| 2. NSP access rules on Managed Redis | **Refused** | redisEnterprise is not an NSP-onboarded type (GA list, 2026-07). Provider resources exist but the association targets an unsupported service — apply failure or a rule that gates nothing. Revisit **only** if Microsoft.Cache/redisEnterprise appears on the onboarded list. |
| 3. Private-endpoint posture as the "carrier" | **Refused** | VNet-scoped, not IP-scoped — cannot honestly carry a CIDR list (§5). A separate "private access" offer may be worth designing someday; it is not this control. |
| 4. Wait for azurerm | **Refused** | There is nothing to wait for: the gap is service-side (no such ARM surface on redisEnterprise), not a provider lag. A wait entry would encode a condition that cannot come true from a provider release alone. |
| 5. **Withdraw on Azure** (#1993 mechanics) | **Recommended** | The control is inexpressible on the only cache Azure lets us deterministically create. `unavailableWhen` on the canvas control with a product-voice reason (Managed Redis secures access with private endpoints, not IP allow-lists); the `baseline:` entry at `infra/config-carriage-exclusions.yaml` becomes a permanent `exclusions:` ceiling carrying this file as evidence; a negative test pins that nothing is emitted (the `NumCacheNodes` withdrawal pattern). |

**Re-open condition** (record it with the exclusion): Microsoft.Cache/redisEnterprise appearing on
the NSP onboarded-resources list — that is the one event that would make a real CIDR carrier
expressible, and it is checkable against one documentation page.

## 7. Sources

- Retirement timeline: `learn.microsoft.com/azure/azure-cache-for-redis/cache-whats-new`
  (July 2026 + October 2025 entries; the target of `aka.ms/AzureCacheForRedisRetirement`).
- Managed Redis network security: `learn.microsoft.com/azure/redis/secure-azure-managed-redis`.
- NSP concepts + onboarded resources: `learn.microsoft.com/azure/private-link/network-security-perimeter-concepts`.
- Provider probes: `tofu providers schema -json` against clean-room pins of azurerm **4.81.0** and
  **5.0.1** (schemas for `azurerm_managed_redis`, `azurerm_redis_firewall_rule`,
  `azurerm_network_security_perimeter_access_rule`, `_association`, `_profile`).
- In-repo apply evidence: `infra/templates/project/azure/modules/azure-cache-redis/main.tf:4-7`;
  probe record on #2148 (release comment, 2026-08-09).
