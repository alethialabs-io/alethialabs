// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { getStaff } from "@/lib/auth/staff";
import { turnoverReport } from "@/lib/turnover";
import { TurnoverDashboard } from "@/components/turnover/turnover-dashboard";
import { StaffShell } from "@/components/staff-shell";

export const metadata: Metadata = {
	title: "Turnover · Alethia staff",
	description: "Running totals against the Bulgarian, EU and US tax thresholds.",
};

// Always fresh: the totals move with every paid invoice.
export const dynamic = "force-dynamic";

/**
 * The staff turnover page (`/turnover`, #7327 EA-5). Gates on `getStaff()` (Cloudflare Access should
 * already have blocked non-staff — defense-in-depth), then reads every running total the tax
 * thresholds use and renders them against their thresholds. The figures and verdicts come from the
 * same `@repo/legal` functions as the console's purchase gate.
 */
export default async function TurnoverPage() {
	const staff = await getStaff();
	if (!staff) {
		return (
			<div className="flex min-h-dvh flex-col items-center justify-center gap-2 px-4 text-center">
				<h1 className="text-lg font-medium text-foreground">Not authorized</h1>
				<p className="max-w-sm text-sm text-muted-foreground">
					This dashboard is for Alethia support staff only. If you believe you
					should have access, contact an administrator.
				</p>
			</div>
		);
	}

	const report = await turnoverReport();

	return (
		<StaffShell staffEmail={staff.email}>
			<div className="mb-6">
				<h1 className="text-xl font-semibold">Turnover and tax thresholds</h1>
				<p className="text-sm text-muted-foreground">
					Paid invoices summed per threshold, from the buyer facts recorded at payment. Voided and
					fully refunded invoices are excluded; a partial refund is not deducted, so the totals read
					high. An alert goes to the operator once at 80% of each threshold and once on reaching it.
					Read-only.
				</p>
			</div>
			<TurnoverDashboard report={report} />
		</StaffShell>
	);
}
