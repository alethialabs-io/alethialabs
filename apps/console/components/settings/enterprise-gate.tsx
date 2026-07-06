"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Entitlement access hook for the settings surfaces. The boolean feature flags resolve
// from the workspace store (hydrated by getWorkspaceContext → ee/ resolveEntitlements);
// gated sections render their content with disabled actions + an in-page upsell
// (components/settings/upgrade/*) rather than hiding behind a wall.

import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import type { Entitlements } from "@/lib/authz/types";

/** The boolean feature-flag keys of Entitlements (excludes the `quotas`/`ai` objects). */
export type FeatureFlag = {
	[K in keyof Entitlements]: Entitlements[K] extends boolean ? K : never;
}[keyof Entitlements];

/** Returns whether a given entitlement is active for the current workspace. */
export function useEntitlement(key: FeatureFlag): boolean {
	return useWorkspaceStore((s) => s.entitlements?.[key] ?? false);
}
