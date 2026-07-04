"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { planMeta } from "@repo/plan-catalog";
import { legalUrl } from "@/lib/legal";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";
import { FEATURE_UPSELLS, type GatedFeature } from "./feature-catalog";

/**
 * The shared call-to-action row for a gated feature: Learn more (docs) · Upgrade to the
 * required tier · Contact Sales (enterprise only). The Pro upgrade opens the in-place
 * upgrade sheet (not a route to Billing) so buying is one click; enterprise routes to
 * sales. Used by both <FeatureUpsell> (in-page panel) and <UpgradeDialog> (modal) so the
 * CTAs never drift.
 */
export function UpsellActions({ feature }: { feature: GatedFeature }) {
	const { openUpgrade } = useUpgradeSheet();
	const meta = FEATURE_UPSELLS[feature];
	const planName = planMeta(meta.requiredPlan).name;

	return (
		<div className="flex flex-wrap items-center justify-center gap-2">
			{meta.requiredPlan === "enterprise" ? (
				<Button size="sm" asChild>
					<a href={legalUrl("/contact/sales")} target="_blank" rel="noreferrer">
						Contact Sales
					</a>
				</Button>
			) : (
				<Button size="sm" onClick={openUpgrade}>
					Upgrade to {planName}
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
