"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@repo/ui/button";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import type { Entitlements } from "@/lib/authz/types";

/** The boolean feature-flag keys of Entitlements (excludes the `quotas` object). */
export type FeatureFlag = {
	[K in keyof Entitlements]: Entitlements[K] extends boolean ? K : never;
}[keyof Entitlements];

/** Returns whether a given entitlement is active for the current workspace. */
export function useEntitlement(key: FeatureFlag): boolean {
	return useWorkspaceStore((s) => s.entitlements?.[key] ?? false);
}

interface EnterpriseGateProps {
	/** The entitlement that unlocks this surface. */
	entitlement: FeatureFlag;
	/** What this section is, for the locked-state copy (e.g. "Member management"). */
	title: string;
	description: string;
	children: ReactNode;
}

/**
 * Renders `children` when the workspace holds `entitlement`, otherwise a polished
 * "Available on Enterprise" panel. Community shows the locked state; the real
 * surface lights up under an Enterprise license (the entitlement comes from the ee/
 * module via getWorkspaceContext → useWorkspaceStore).
 */
export function EnterpriseGate({
	entitlement,
	title,
	description,
	children,
}: EnterpriseGateProps) {
	const enabled = useEntitlement(entitlement);
	if (enabled) return <>{children}</>;

	return (
		<div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/10 px-6 py-16 text-center">
			<div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
				<Sparkles className="h-5 w-5" />
			</div>
			<h3 className="mt-4 text-sm font-semibold text-foreground">
				{title} is an Enterprise feature
			</h3>
			<p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>
			<Button variant="outline" size="sm" className="mt-5" asChild>
				<a href="/docs/access-control/open-core" target="_blank" rel="noreferrer">
					Learn about Enterprise
				</a>
			</Button>
		</div>
	);
}
