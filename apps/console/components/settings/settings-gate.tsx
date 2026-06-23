"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The consistent settings gate. A page always renders its own header; its BODY is
// wrapped in <SettingsGate>, which shows the content when the entitlement is held,
// otherwise a single, consistent call-to-action panel:
//   - no paid org yet  → "Create an organization" (opens the create-org sheet)
//   - has an org, but the feature needs a higher tier → "Upgrade plan" (→ Billing)
// This replaces the page-level EnterpriseGate so every section behaves the same way
// (header visible, body gated) instead of some fully locking and others not.

import { Lock, Sparkles } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import {
	type FeatureFlag,
	useEntitlement,
} from "@/components/settings/enterprise-gate";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { Button } from "@/components/ui/button";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { globalHref } from "@/lib/routing";

function GatePanel({
	icon,
	title,
	description,
	cta,
}: {
	icon: ReactNode;
	title: string;
	description: string;
	cta: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-sunken px-6 py-16 text-center">
			<div className="flex size-11 items-center justify-center rounded-full bg-surface-muted text-text-tertiary">
				{icon}
			</div>
			<h3 className="mt-4 text-sm font-semibold text-text-primary">{title}</h3>
			<p className="mt-1.5 max-w-sm text-sm text-text-tertiary">{description}</p>
			<div className="mt-5">{cta}</div>
		</div>
	);
}

/**
 * Gates a section body on `entitlement`. `feature` is the human label used in the copy
 * (e.g. "Member management"). Render the page header OUTSIDE this so it stays visible.
 */
export function SettingsGate({
	entitlement,
	feature,
	children,
}: {
	entitlement: FeatureFlag;
	feature: string;
	children: ReactNode;
}) {
	const enabled = useEntitlement(entitlement);
	// "organizations" is the floor — holding it means there's a real paid org.
	const hasOrg = useEntitlement("organizations");
	const orgSlug = useActiveOrgSlug();
	const [createOpen, setCreateOpen] = useState(false);

	if (enabled) return <>{children}</>;

	if (!hasOrg) {
		return (
			<>
				<GatePanel
					icon={<Sparkles className="size-5" />}
					title="Create an organization"
					description={`${feature} lives in a shared organization. Create one to collaborate with your team on a paid plan — your personal Zones and Specs stay yours.`}
					cta={
						<Button onClick={() => setCreateOpen(true)}>Create organization</Button>
					}
				/>
				<CreateOrgSheet open={createOpen} onOpenChange={setCreateOpen} />
			</>
		);
	}

	return (
		<GatePanel
			icon={<Lock className="size-5" />}
			title={`${feature} needs a higher plan`}
			description={`Your organization's current plan doesn't include ${feature.toLowerCase()}. Upgrade to unlock it.`}
			cta={
				<Button asChild>
					<Link href={globalHref(orgSlug, "settings/billing")}>Upgrade plan</Link>
				</Button>
			}
		/>
	);
}
