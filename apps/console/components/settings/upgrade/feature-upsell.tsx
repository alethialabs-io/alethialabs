"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The in-page upsell panel. Unlike the old SettingsGate, this does NOT replace the page —
// it sits where a gated feature's empty state / primary action would, while the rest of
// the surface stays visible (read-only). Shown when an Enterprise/Pro feature is locked.

import { planMeta } from "@repo/plan-catalog";
import { cn } from "@repo/ui/utils";
import { FEATURE_UPSELLS, type GatedFeature } from "./feature-catalog";
import { UpsellActions } from "./upsell-actions";

/** A polished "available on {plan}" panel for a gated feature. */
export function FeatureUpsell({
	feature,
	className,
}: {
	feature: GatedFeature;
	className?: string;
}) {
	const meta = FEATURE_UPSELLS[feature];
	const Icon = meta.icon;
	const planName = planMeta(meta.requiredPlan).name;

	return (
		<div
			className={cn(
				"flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-sunken px-6 py-14 text-center",
				className,
			)}
		>
			<div className="flex size-11 items-center justify-center rounded-full bg-surface-muted text-text-tertiary">
				<Icon className="size-5" />
			</div>
			<h3 className="mt-4 text-sm font-semibold text-text-primary">{meta.title}</h3>
			<p className="mt-1.5 max-w-sm text-sm text-text-tertiary">{meta.blurb}</p>
			<p className="mt-2 text-[12px] font-medium text-text-secondary">
				Available on the {planName} plan.
			</p>
			<div className="mt-5">
				<UpsellActions feature={feature} />
			</div>
		</div>
	);
}
