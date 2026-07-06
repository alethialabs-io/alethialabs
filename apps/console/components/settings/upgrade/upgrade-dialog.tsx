"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The modal variant of the upsell, shown when a user attempts a gated ACTION (e.g. clicks
// "Invite member" on a Hobby org, or "Create role" without Enterprise). Same copy + CTAs
// as <FeatureUpsell>. Works both uncontrolled (pass a `trigger`) and controlled (`open` /
// `onOpenChange`) so it can wrap a button or be opened imperatively.

import { type ReactNode, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@repo/ui/dialog";
import { planMeta } from "@repo/plan-catalog";
import { FEATURE_UPSELLS, type GatedFeature } from "./feature-catalog";
import { UpsellActions } from "./upsell-actions";

/** "Available on {plan}" modal for a gated action. */
export function UpgradeDialog({
	feature,
	trigger,
	open: openProp,
	onOpenChange,
}: {
	feature: GatedFeature;
	trigger?: ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const [internalOpen, setInternalOpen] = useState(false);
	const open = openProp ?? internalOpen;
	const setOpen = onOpenChange ?? setInternalOpen;

	const meta = FEATURE_UPSELLS[feature];
	const Icon = meta.icon;
	const planName = planMeta(meta.requiredPlan).name;

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			{trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<div className="mb-1 flex size-10 items-center justify-center rounded-full bg-surface-muted text-text-tertiary">
						<Icon className="size-5" />
					</div>
					<DialogTitle>{meta.title}</DialogTitle>
					<DialogDescription>
						{meta.blurb} This feature is available on the {planName} plan.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter className="sm:justify-start">
					<UpsellActions feature={feature} />
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
