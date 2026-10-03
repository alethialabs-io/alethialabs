"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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

	// Contact Sales and Learn more are `<a href>` that open a new tab, so they are LINKS. base-ui's
	// Button merges `{role: "button"}` onto every non-native element (`use-button/useButton.js`),
	// so without the explicit `role="link"` a screen reader announced a button that navigates
	// away, and `getByRole("link", { name: /contact sales/i })` found nothing in any upgrade
	// dialog (#5413). External props win that merge — the same fix as
	// `app/(private)/[org]/not-found.tsx`. "Upgrade to …" opens a sheet in place and stays a button.
	return (
		<div className="flex flex-wrap items-center justify-center gap-2">
			{meta.requiredPlan === "enterprise" ? (
				<Button size="sm" nativeButton={false} role="link" render={<a href={legalUrl("/contact/sales")} target="_blank" rel="noreferrer" />}>
					Contact Sales
				</Button>
			) : (
				<Button size="sm" onClick={openUpgrade}>
					Upgrade to {planName}
				</Button>
			)}
			<Button size="sm" variant="ghost" nativeButton={false} role="link" render={<a href={meta.learnMoreHref} target="_blank" rel="noreferrer" />}>
				Learn more
			</Button>
		</div>
	);
}
