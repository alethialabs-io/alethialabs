"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The runners page's Pools column (self-managed deployments only): the configured warm pools joined
// with their observed runners, and the pool editor. Its own data region (RUBRIC B5): the fleet read
// failing takes down this column, not the page.

import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { SectionHeading } from "@repo/ui/section-heading";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { RegionError } from "@repo/ui/region-error";
import { RegionRefusal } from "@/components/errors/region-refusal";
import { MANAGE_PENDING_REASON, manageReason } from "@/components/errors/manage-gate";
import { isForbidden } from "@/components/overview/overview-reads";
import { FleetPoolWizard } from "@/components/runners/fleet-pool-wizard";
import { PoolCard, PoolCardSkeleton, PoolsEmpty } from "@/components/runners/pool-card";
import type { FleetPool } from "@/lib/db/schema";
import { useDeletePool, useFleetEconomicsQuery, useFleetQuery, useSetPoolEnabled } from "@/lib/query/use-fleet-query";

/**
 * The Pools column. Server-prefetched (`runners.fleet`), so it paints with data; live through the
 * `fleet`, `runners` and `jobs` topics. Pending, error and empty are three distinct renders.
 */
export function PoolsSection() {
	const { data: fleet, isPending, isError, error, refetch } = useFleetQuery();
	const setPoolEnabled = useSetPoolEnabled();
	const deletePool = useDeletePool();
	const poolViews = fleet?.pools ?? [];
	const poolConfigs = fleet?.configs ?? [];
	const canManageFleet = fleet?.canManageFleet ?? false;
	const hasPools = poolViews.length > 0;

	// Economics are their own read (a failure there leaves the cards without cost lines, nothing more).
	const { data: economics } = useFleetEconomicsQuery();
	const econByProvider = useMemo(() => new Map((economics?.pools ?? []).map((p) => [p.provider, p])), [economics]);

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

	// "Add pool" is never hidden from a viewer who cannot use it: it is disabled with the reason.
	// Until the fleet read answers, nobody is known to be able to use it.
	const addPoolReason = fleet ? manageReason({ canManage: canManageFleet }) : MANAGE_PENDING_REASON;
	const addPool = (
		<DisabledReason reason={addPoolReason}>
			<Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={openCreate}>
				<Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> Add pool
			</Button>
		</DisabledReason>
	);

	return (
		<section className="space-y-3">
			{/* The shared section heading, as the Runners column beside it uses: one look for a heading
			    on this page. No count pill: the page's ONE count is the runner grid's result count, and a
			    second pill earlier in the page would be read as the grid's (e2e/audit/filters.ts reads the
			    first one in the main region). The pool cards themselves say how many there are. */}
			<SectionHeading
				title="Pools"
				// The heading carries "Add pool" while pools are listed; with none, the empty state below
				// carries it, so the control is on screen once. No action while the read has failed.
				actions={!isError && (isPending || hasPools) ? addPool : undefined}
			/>

			{canManageFleet && hasPools && !fleet?.fleetProviderActive && (
				<p className="border border-dashed border-border px-3 py-2 font-mono text-ui-2xs leading-relaxed text-muted-foreground">
					No cloud provider wired — pools are advisory. Set{" "}
					<span className="text-foreground">FLEET_PROVIDER=hcloud</span> to provision real runners.
				</p>
			)}

			{isError && isForbidden(error) ? (
				// An expected refusal, not a failure: no retry that would answer the same (RUBRIC B4).
				<RegionRefusal compact refusal="forbidden" subject="the warm pools" />
			) : isError ? (
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
								onDelete={canManageFleet && !busy ? () => deletePool.mutateAsync({ id: pool.id }) : undefined}
							/>
						);
					})}
				</div>
			) : (
				<PoolsEmpty action={addPool} />
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
