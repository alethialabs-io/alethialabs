// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { getStaff } from "@/lib/auth/staff";
import { getFunnelReport } from "@/lib/platform/console-client";
import { NotAuthorized } from "@/components/not-authorized";
import { StaffShell } from "@/components/staff-shell";
import { FunnelView, WindowSwitch } from "./funnel-view";
import { type FunnelReport, funnelReportSchema, parseWindow } from "./report";

export const metadata: Metadata = {
	title: "Funnel · Alethia staff",
	description: "Sign-up funnel from the service's own tables: daily counts per stage and per cloud.",
};

// Always fresh — a launch-day read, not a cacheable page.
export const dynamic = "force-dynamic";

/** Fetches and validates the report; answers the reason instead of throwing, so the page can say it. */
async function loadReport(
	days: number,
): Promise<{ ok: true; report: FunnelReport } | { ok: false; reason: string }> {
	try {
		const parsed = funnelReportSchema.safeParse(await getFunnelReport(days));
		if (!parsed.success) {
			return { ok: false, reason: "The console answered a funnel this page does not recognise." };
		}
		return { ok: true, report: parsed.data };
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : "The funnel request failed." };
	}
}

/**
 * The staff funnel (`/funnel`, REL-L12). Gated on `getStaff()` like every staff read (Cloudflare
 * Access should already have blocked non-staff — defense-in-depth). The counts come from the
 * console's Postgres tables, not from product analytics, so they include people who declined
 * analytics; the page shows aggregates only and has no per-person drill-down.
 */
export default async function FunnelPage({
	searchParams,
}: {
	searchParams: Promise<{ days?: string }>;
}) {
	const staff = await getStaff();
	if (!staff) return <NotAuthorized />;

	const days = parseWindow((await searchParams).days);
	const result = await loadReport(days);

	return (
		<StaffShell staffEmail={staff.email} active="funnel">
			<div className="mb-6 flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="text-xl font-semibold">Funnel</h1>
					<p className="text-sm text-muted-foreground">
						Counted from the service&apos;s own tables, so it includes everyone, not only
						people who accepted analytics. Aggregate counts only. Read-only.
					</p>
				</div>
				<WindowSwitch days={days} />
			</div>
			{result.ok ? (
				<FunnelView report={result.report} />
			) : (
				<div role="alert" className="rounded-md border p-4 text-sm">
					<p className="font-medium">The funnel could not be loaded.</p>
					<p className="text-muted-foreground">{result.reason}</p>
				</div>
			)}
		</StaffShell>
	);
}
