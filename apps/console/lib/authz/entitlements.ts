// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Actor, Entitlements } from "@/lib/authz/types";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";

/**
 * Feature entitlements for a scope (spec 07 Part F, seam 5). Entitlements are
 * resolved once — asynchronously — when the actor's scope is built (getActiveScope →
 * the ee/ per-org resolver, which reads the org's billing record / signed license),
 * and attached to the actor. This accessor just reads them synchronously, so call
 * sites (server actions, the org-creation gate) stay sync. Core has no
 * `if (licensed)` anywhere — an actor with no resolved entitlements (community build,
 * or a scope built outside getActiveScope) falls back to the all-off baseline.
 */
export function getEntitlements(actor: Actor): Entitlements {
	return actor.entitlements ?? COMMUNITY_ENTITLEMENTS;
}
