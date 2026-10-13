"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Entitlement access hook for the settings surfaces. The boolean feature flags resolve
// from the workspace store (hydrated by getWorkspaceContext → ee/ resolveEntitlements);
// gated sections render their content with disabled actions + an in-page upsell
// (components/settings/upgrade/*) rather than hiding behind a wall — once the store has
// answered. Before it has, the answer is unknown and neither is shown (see EntitlementState).

import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import type { Entitlements } from "@/lib/authz/types";

/** The boolean feature-flag keys of Entitlements (excludes the `quotas`/`ai` objects). */
export type FeatureFlag = {
	[K in keyof Entitlements]: Entitlements[K] extends boolean ? K : never;
}[keyof Entitlements];

/**
 * An entitlement as the client knows it: `true` / `false` once the workspace store has loaded,
 * `null` while it has not.
 *
 * `null` is a THIRD state, not a spelling of `false` (#5864). The store's `entitlements` is `null`
 * on the server render and on every first client paint — `fetchWorkspace()` answers after
 * hydration — so reading it as "not entitled" showed every paying org the upsell or a disabled
 * control for as long as that round trip took. The two halves of a gate read it differently, and
 * a caller must write both out:
 *
 * - **unlock** a paid action or paid content only on `=== true` (`if (state)` is the same thing,
 *   since `null` is falsy) — an unknown entitlement never unlocks anything;
 * - **upsell** (or disable with an "upgrade" reason) only on `=== false` — `!state` is WRONG here,
 *   because it is also true for `null`.
 *
 * For `null`, render nothing gated: neither the paid surface nor its upsell. Server and first
 * client render both see `null`, so this state cannot cause a hydration mismatch.
 */
export type EntitlementState = boolean | null;

/** Returns whether a given entitlement is active for the current workspace — `null` while unknown. */
export function useEntitlement(key: FeatureFlag): EntitlementState {
	return useWorkspaceStore((s) => (s.entitlements === null ? null : s.entitlements[key]));
}
