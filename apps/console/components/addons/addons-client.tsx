"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Add-ons marketplace for a project environment: browse the free-OSS catalog grouped by
// category, enable/configure an add-on (writes a PENDING row applied on the next Deploy), and
// watch its ArgoCD health once deployed. Managed apply in Phase 1; GitOps mode is Phase 2.

import { useState } from "react";
import { Skeleton } from "@repo/ui/skeleton";
import type { AddonMarketItem } from "@/app/server/actions/addons";
import type { AddOnCategory } from "@/lib/addons/types";
import { useAddonsQuery } from "@/lib/query/use-addons-query";
import { AddonCard } from "./addon-card";
import { ConfigureSheet } from "./configure-sheet";

/** Display order + labels for the catalog category sections. */
const CATEGORY_LABELS: Record<AddOnCategory, string> = {
	observability: "Observability",
	security: "Security posture",
	secrets: "Secrets",
	networking: "Networking",
	platform: "Platform",
	autoscaling: "Autoscaling",
	backup: "Backup",
	policy: "Policy",
	data: "Data",
};
const CATEGORY_ORDER: AddOnCategory[] = [
	"observability",
	"security",
	"secrets",
	"networking",
	"platform",
	"autoscaling",
	"backup",
	"policy",
	"data",
];

export function AddonsClient({
	projectId,
	environmentId,
}: {
	projectId: string;
	environmentId: string | null;
}) {
	const { data, isPending } = useAddonsQuery(projectId, environmentId);
	const [configuring, setConfiguring] = useState<AddonMarketItem | null>(null);
	const [sheetOpen, setSheetOpen] = useState(false);

	const openConfigure = (item: AddonMarketItem) => {
		setConfiguring(item);
		setSheetOpen(true);
	};

	if (isPending || !data) {
		return (
			<div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
				{[0, 1, 2, 3].map((i) => (
					<Skeleton key={i} className="h-40 w-full rounded-lg" />
				))}
			</div>
		);
	}

	// Group the catalog by category, preserving the intended section order.
	const byCategory = new Map<AddOnCategory, AddonMarketItem[]>();
	for (const item of data.items) {
		const list = byCategory.get(item.category) ?? [];
		list.push(item);
		byCategory.set(item.category, list);
	}
	const installedCount = data.items.filter((i) => i.install !== null).length;

	return (
		<div className="space-y-8">
			<div className="space-y-1">
				<h1 className="text-xl font-semibold">Add-ons</h1>
				<p className="text-sm text-muted-foreground">
					Free, open-source apps your cluster comes up with — installed via GitOps
					into your own cluster. Changes apply on your next Deploy.
					{installedCount > 0 && ` · ${installedCount} enabled`}
				</p>
			</div>

			{CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((category) => (
				<section key={category} className="space-y-3">
					<h2 className="text-sm font-medium text-muted-foreground">
						{CATEGORY_LABELS[category]}
					</h2>
					<div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
						{(byCategory.get(category) ?? []).map((item) => (
							<AddonCard
								key={item.id}
								item={item}
								projectId={projectId}
								environmentId={environmentId}
								onConfigure={openConfigure}
							/>
						))}
					</div>
				</section>
			))}

			<ConfigureSheet
				item={configuring}
				projectId={projectId}
				environmentId={data.environmentId}
				hasAppsRepo={data.hasAppsRepo}
				open={sheetOpen}
				onOpenChange={setSheetOpen}
			/>
		</div>
	);
}
