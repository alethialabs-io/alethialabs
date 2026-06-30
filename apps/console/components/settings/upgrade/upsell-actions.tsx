"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { Button } from "@repo/ui/button";
import { planMeta } from "@repo/plan-catalog";
import { legalUrl } from "@/lib/legal";
import { globalHref } from "@/lib/routing";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { FEATURE_UPSELLS, type GatedFeature } from "./feature-catalog";

/**
 * The shared call-to-action row for a gated feature: Learn more (docs) · Upgrade to the
 * required tier (→ Billing) · Contact Sales (→ marketing, enterprise only). Used by both
 * <FeatureUpsell> (in-page panel) and <UpgradeDialog> (modal) so the CTAs never drift.
 */
export function UpsellActions({ feature }: { feature: GatedFeature }) {
	const orgSlug = useActiveOrgSlug();
	const meta = FEATURE_UPSELLS[feature];
	const planName = planMeta(meta.requiredPlan).name;

	return (
		<div className="flex flex-wrap items-center justify-center gap-2">
			<Button size="sm" asChild>
				<Link href={globalHref(orgSlug, "settings/billing")}>
					Upgrade to {planName}
				</Link>
			</Button>
			{meta.requiredPlan === "enterprise" && (
				<Button size="sm" variant="outline" asChild>
					<a href={legalUrl("/contact/sales")} target="_blank" rel="noreferrer">
						Contact Sales
					</a>
				</Button>
			)}
			<Button size="sm" variant="ghost" asChild>
				<a href={meta.learnMoreHref} target="_blank" rel="noreferrer">
					Learn more
				</a>
			</Button>
		</div>
	);
}
