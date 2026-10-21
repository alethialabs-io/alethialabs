"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The runners page's Pools column (self-managed deployments only): the configured warm pools joined
// with their observed runners, and the pool editor. Its own data region (RUBRIC B5): the fleet read
// failing takes down this column, not the page.

import { Button } from "@repo/ui/button";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { RegionError } from "@/components/errors/region-error";
import { FleetPoolWizard } from "@/components/runners/fleet-pool-wizard";
import { PoolCard, PoolCardSkeleton, PoolsEmpty } from "@/components/runners/pool-card";
import type { FleetPool } from "@/lib/db/schema";
import { useDeletePool, useFleetQuery, useSetPoolEnabled } from "@/lib/query/use-fleet-query";

/**
 * The Pools column. Server-prefetched (`runners.fleet`), so it paints with data; live through the
 * `fleet`, `runners` and `jobs` topics. Pending, error and empty are three distinct renders.
 */
export function PoolsSection() {
	const { data: fleet, isPending, isError, refetch } = useFleetQuery();
	const setPoolEnabled = useSetPoolEnabled();
	const deletePool = useDeletePool();
	const poolViews = fleet?.pools ?? [];
	const poolConfigs = fleet?.configs ?? [];
	const canManageFleet = fleet?.canManageFleet ?? false;
	const hasPools = poolViews.length > 0;

	const econByProvider = useMemo(
		() => new Map((fleet?.economics?.pools ?? []).map((p) => [p.provider, p])),
		[fleet?.economics],
	);

	// Pool editor: null pool = create, a row = edit.
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<FleetPool | null>(null);
	const openCreate = () => {
		setEditing(null);
		setDialogOpen(true);
	};
	const openEdit = (id: string) => {
		setEditing(poolConfigs.find((c) => c.id === id) ?? null);
		setDialogOpen(true);
	};

	return (
		<section className="space-y-3">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-baseline gap-2">
					<span className="text-sm font-semibold tracking-tight text-foreground">Pools</span>
					{hasPools && (
						<span className="font-mono text-ui-2xs uppercase tracking-[0.08em] text-muted-foreground">
							{poolViews.length} configured
						</span>
					)}
				</div>
				{canManageFleet && (
					<Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={openCreate}>
						<Plus className="mr-1 h-3.5 w-3.5" /> Add pool
					</Button>
				)}
			</div>

			{canManageFleet && hasPools && !fleet?.fleetProviderActive && (
				<p className="border border-dashed border-border px-3 py-2 font-mono text-ui-2xs leading-relaxed text-muted-foreground">
					No cloud provider wired — pools are advisory. Set{" "}
					<span className="text-foreground">FLEET_PROVIDER=hcloud</span> to provision real runners.
				</p>
			)}

			{isError ? (
				<RegionError
					title="Couldn't load pools"
					description="Something went wrong fetching the warm pools. Try again."
					onRetry={() => void refetch()}
				/>
			) : isPending ? (
				<div className="space-y-4">
					<PoolCardSkeleton />
					<PoolCardSkeleton />
				</div>
			) : hasPools ? (
				<div className="space-y-4">
					{poolViews.map((pool) => {
						const busy =
							(setPoolEnabled.isPending && setPoolEnabled.variables?.id === pool.id) ||
							(deletePool.isPending && deletePool.variables?.id === pool.id);
						return (
							<PoolCard
								key={pool.id}
								pool={pool}
								economics={econByProvider.get(pool.provider)}
								canManage={canManageFleet}
								onEdit={canManageFleet ? () => openEdit(pool.id) : undefined}
								onToggle={
									canManageFleet && !busy
										? () => setPoolEnabled.mutate({ id: pool.id, enabled: !pool.enabled })
										: undefined
								}
								onDelete={canManageFleet && !busy ? () => deletePool.mutate({ id: pool.id }) : undefined}
							/>
						);
					})}
				</div>
			) : (
				<PoolsEmpty />
			)}

			{canManageFleet && (
				<FleetPoolWizard
					open={dialogOpen}
					onOpenChange={setDialogOpen}
					pool={editing}
					usedProviders={poolConfigs.map((c) => c.provider)}
				/>
			)}
		</section>
	);
}
