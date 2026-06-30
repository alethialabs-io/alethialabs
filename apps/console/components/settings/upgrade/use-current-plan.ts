"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { BillingPlan } from "@/lib/db/schema/enums";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

/**
 * The active organization's effective billing plan ("community" / "team" / "enterprise"),
 * read from the workspace store. Falls back to "community" while loading or in personal
 * scope. Used by the upsell UI to phrase the target tier.
 */
export function useCurrentPlan(): BillingPlan {
	return useWorkspaceStore(
		(s) =>
			s.organizations.find((o) => o.id === s.activeOrgId)?.plan ?? "community",
	);
}
