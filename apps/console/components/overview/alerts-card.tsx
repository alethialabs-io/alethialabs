"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview Alerts card — the org's most recent alert deliveries. Deliveries carry a
// delivery status (sent/failed/…), not a per-event severity, so the dot + right-hand pill
// read off the delivery status (grayscale, via StatusBadge tiers).

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { BellOff, Zap } from "lucide-react";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import {
	type DeliveryDTO,
	getAlertsBootstrap,
} from "@/app/server/actions/alerts";
import { globalHref } from "@/lib/routing";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";

/** Delivery status → grayscale tier for the left-hand dot. */
const DELIVERY_TIER: Record<string, StatusTier> = {
	failed: "failed",
	retrying: "pending",
	pending: "pending",
	sent: "active",
	skipped: "disabled",
};

const MAX_ROWS = 4;

/** Recent alert deliveries for the org. */
export function AlertsCard({ orgSlug }: { orgSlug: string }) {
	const { openUpgrade } = useUpgradeSheet();
	const [deliveries, setDeliveries] = useState<DeliveryDTO[] | null>(null);
	// null until loaded; true/false once the bootstrap resolves the plan's alerting grant.
	const [alerting, setAlerting] = useState<boolean | null>(null);

	useEffect(() => {
		let alive = true;
		getAlertsBootstrap()
			.then((b) => {
				if (!alive) return;
				setAlerting(b.alerting);
				setDeliveries(b.deliveries.slice(0, MAX_ROWS));
			})
			.catch(() => {
				if (alive) {
					setAlerting(true); // can't tell — fall back to the neutral empty state
					setDeliveries([]);
				}
			});
		return () => {
			alive = false;
		};
	}, []);

	return (
		<div className="rounded-lg border bg-card shadow-sm">
			<div className="flex min-h-[50px] items-center gap-2 border-b px-4 py-2.5">
				<span className="font-display text-sm font-semibold">Alerts</span>
				<span className="font-mono text-[10px] text-muted-foreground">
					{deliveries === null || alerting === false
						? ""
						: `${deliveries.length} recent`}
				</span>
				<Link
					href={globalHref(orgSlug, "alerts")}
					className="ml-auto font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
				>
					Manage →
				</Link>
			</div>

			{deliveries === null ? (
				<div className="space-y-2 p-4">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-9 w-full rounded-md" />
					))}
				</div>
			) : alerting === false ? (
				<div className="flex flex-col items-center gap-2.5 px-4 py-7 text-center">
					<BellOff className="h-5 w-5 text-muted-foreground/70" />
					<p className="max-w-[34ch] text-xs text-muted-foreground">
						Alerting — notification channels and policies — unlocks on the Pro plan.
					</p>
					<Button
						variant="outline"
						size="xs"
						className="gap-1.5 text-xs"
						onClick={openUpgrade}
					>
						<Zap className="h-3 w-3" />
						Upgrade
					</Button>
				</div>
			) : deliveries.length === 0 ? (
				<p className="px-4 py-8 text-center font-mono text-xs text-muted-foreground">
					No recent alerts.
				</p>
			) : (
				deliveries.map((d) => (
					<div
						key={d.id}
						className="flex items-start gap-3 border-b border-border/60 px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/40"
					>
						<StatusBadge
							status={d.status}
							tier={DELIVERY_TIER[d.status] ?? "idle"}
							showLabel={false}
							className="mt-1"
						/>
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="truncate text-[13px] text-foreground">
								{d.title}
							</span>
							<span className="truncate font-mono text-[10px] text-muted-foreground">
								{d.event_key} ·{" "}
								{formatDistanceToNow(new Date(d.created_at), {
									addSuffix: true,
								})}
							</span>
						</div>
						<span className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
							{d.status}
						</span>
					</div>
				))
			)}
		</div>
	);
}
