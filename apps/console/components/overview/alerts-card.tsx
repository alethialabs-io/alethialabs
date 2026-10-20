"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview Alerts card — the org's most recent alert deliveries. Deliveries carry a delivery status
// (sent/failed/…), not a per-event severity, so the dot + right-hand pill read off the delivery
// status (grayscale, via StatusBadge tiers).
//
// #6118: the read is the `overview.alerts` GET procedure, prefetched by the page on the server.
// Pending, forbidden, plan-gated, empty, failed and answered are six distinct renders — a failure
// used to fall through to "No recent alerts.", which told the viewer something false.

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import Link from "next/link";
import { formatRelative } from "@repo/format";
import { BellOff, Lock, Zap } from "lucide-react";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { Skeleton } from "@repo/ui/skeleton";
import { RegionError } from "@/components/errors/region-error";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";
import { CARD_EMPTY } from "@/components/overview/card-empty";
import { globalHref } from "@/lib/routing";
import { orpc } from "@/lib/rpc/client";
import { ClockSlot } from "./clock-slot";
import { isForbidden, retryUnlessRefused } from "./overview-reads";

/** Delivery status → grayscale tier for the left-hand dot. */
const DELIVERY_TIER: Record<string, StatusTier> = {
	failed: "failed",
	retrying: "pending",
	pending: "pending",
	sent: "active",
	skipped: "disabled",
};

/** The card's frame and header strip — shared by every render, the route skeleton included. */
function AlertsFrame({ orgSlug, caption, children }: { orgSlug?: string; caption?: string; children: ReactNode }) {
	return (
		<section aria-label="Alerts" className="rounded-lg border bg-card shadow-sm">
			<div className="flex min-h-[50px] items-center gap-2 border-b px-4 py-2.5">
				<span className="font-display text-sm font-semibold">Alerts</span>
				{caption ? <span className="font-mono text-ui-2xs text-muted-foreground">{caption}</span> : null}
				{orgSlug ? (
					<Link
						href={globalHref(orgSlug, "alerts")}
						className="ml-auto font-mono text-ui-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						Manage →
					</Link>
				) : null}
			</div>
			{children}
		</section>
	);
}

/** One delivery row's placeholder, at the row's real height. */
function DeliverySkeleton() {
	return (
		<div className="flex items-start gap-3 border-b border-border/60 px-4 py-3 last:border-b-0">
			<Skeleton className="mt-1 size-2 shrink-0 rounded-full" />
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<Skeleton className="h-3.5 w-40" />
				<Skeleton className="h-2.5 w-28" />
			</div>
			<Skeleton className="h-4 w-12 rounded-full" />
		</div>
	);
}

/** The card while its read is pending; the route's `loading.tsx` renders this too. */
export function AlertsCardSkeleton() {
	return (
		<AlertsFrame>
			<div aria-busy="true">
				<DeliverySkeleton />
				<DeliverySkeleton />
			</div>
		</AlertsFrame>
	);
}

/** Recent alert deliveries for the org. */
export function AlertsCard({ orgSlug }: { orgSlug: string }) {
	const alerts = useQuery(orpc.overview.alerts.queryOptions({ retry: retryUnlessRefused }));

	if (alerts.data === undefined) {
		if (alerts.isError && isForbidden(alerts.error)) {
			// An expected refusal, not a failure: retrying will not change it, so there is no button.
			return (
				<AlertsFrame orgSlug={orgSlug}>
					<EmptyState
						className={CARD_EMPTY}
						icon={<Lock />}
						title="You don't have access to alerts."
						description="Ask an organization admin for a role that can view alerts."
					/>
				</AlertsFrame>
			);
		}
		if (alerts.isError) {
			return (
				<AlertsFrame orgSlug={orgSlug}>
					<RegionError
						title="Couldn't load alerts"
						description="Something went wrong loading recent alert deliveries."
						onRetry={() => alerts.refetch()}
					/>
				</AlertsFrame>
			);
		}
		return <AlertsCardSkeleton />;
	}

	const { alerting, deliveries } = alerts.data;
	if (!alerting) {
		// A locked feature stands exactly where its rows would have been, which is what §6 calls an
		// empty state — so it is the same shape as the empty one below rather than a second centred div.
		return (
			<AlertsFrame orgSlug={orgSlug}>
				<AlertingUpsell />
			</AlertsFrame>
		);
	}

	return (
		<AlertsFrame orgSlug={orgSlug} caption={`${deliveries.length} recent`}>
			{deliveries.length === 0 ? (
				<EmptyState className={CARD_EMPTY} title="No recent alerts." />
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
							<span className="truncate text-ui-md text-foreground">{d.title}</span>
							<span className="truncate font-mono text-ui-2xs text-muted-foreground">
								{d.event_key} ·{" "}
								<ClockSlot sizer="less than a minute ago" render={() => formatRelative(d.created_at)} />
							</span>
						</div>
						<span className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-ui-3xs uppercase tracking-wide text-muted-foreground">
							{d.status}
						</span>
					</div>
				))
			)}
		</AlertsFrame>
	);
}

/** The plan gate: alerting is not on this organization's plan. */
function AlertingUpsell() {
	const { openUpgrade } = useUpgradeSheet();
	return (
		<EmptyState
			className={CARD_EMPTY}
			icon={<BellOff />}
			title="Alerting is a Pro feature"
			description="Notification channels and policies unlock on the Pro plan."
			action={
				<Button variant="outline" size="xs" className="gap-1.5 text-xs" onClick={openUpgrade}>
					<Zap className="h-3 w-3" />
					Upgrade
				</Button>
			}
		/>
	);
}
