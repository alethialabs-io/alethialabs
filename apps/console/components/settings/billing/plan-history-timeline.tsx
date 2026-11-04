"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Plan-history timeline (Billing page). Derived honestly from what we know today
// (org created + current plan) — there's no billing event log yet, so this stays
// minimal rather than inventing history.

// The read is `billing.planHistory` over GET, prefetched by the route (#6127). It used to toast
// "Couldn't load plan history." and leave its skeleton up forever — including for every member
// without the billing permission, whose read is always refused.

import { useQuery } from "@tanstack/react-query";
import { RegionError } from "@/components/errors/region-error";
import { RegionRefusal, refusalOf, retryUnlessRefused } from "@/components/settings/billing/read-state";
import { SettingsSection } from "@/components/settings/settings-ui";
import { ClockText } from "@/components/settings/usage/clock-text";
import { orpc } from "@/lib/rpc/client";
import { formatDate } from "@repo/format";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";

/** The Plan history section: the timeline, or its pending / refused / failed render. */
export function PlanHistoryTimeline() {
	const history = useQuery(orpc.billing.planHistory.queryOptions({ retry: retryUnlessRefused }));
	const entries = history.data;

	if (entries === undefined && history.isError) {
		const refusal = refusalOf(history.error);
		return (
			<SettingsSection title="Plan history">
				{refusal ? (
					<RegionRefusal refusal={refusal} />
				) : (
					<RegionError
						title="Couldn't load plan history"
						description="Something went wrong reading this organization's plan history."
						onRetry={() => void history.refetch()}
					/>
				)}
			</SettingsSection>
		);
	}

	return (
		<SettingsSection title="Plan history">
			<div className="rounded-lg border border-border bg-surface px-6 pb-2.5 pt-5 shadow-sm">
				{!entries ? (
					<Skeleton className="h-20 w-full" />
				) : entries.length === 0 ? (
					<div className="text-ui-md text-text-tertiary">No plan history yet.</div>
				) : (
					<div className="relative pl-[26px] before:absolute before:bottom-[18px] before:left-1 before:top-1 before:w-px before:bg-border-strong before:content-['']">
						{entries.map((e) => (
							<div key={`${e.when}:${e.title}`} className="relative pb-5 last:pb-0">
								<div
									className={cn(
										"absolute -left-[26px] top-0.5 size-[9px] rounded-full border-[1.5px]",
										e.current
											? "border-text-primary bg-text-primary ring-[3px] ring-surface-muted"
											: "border-text-tertiary bg-surface",
									)}
								/>
								<div className="mb-1 font-mono text-ui-2xs text-text-tertiary">
									<ClockText sizer="30 Sept 2026" text={() => formatDate(e.when)} />
								</div>
								<div className="text-ui-md text-text-primary">{e.title}</div>
								<div className="mt-0.5 text-ui-sm text-text-tertiary">{e.detail}</div>
							</div>
						))}
					</div>
				)}
			</div>
		</SettingsSection>
	);
}
