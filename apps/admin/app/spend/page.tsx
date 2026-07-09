// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { getStaff } from "@/lib/auth/staff";
import { getServiceDb } from "@/lib/db";
import { aiSpendRollup } from "@/lib/queries";
import { AiSpendDashboard } from "@/components/ai-spend-dashboard";
import { StaffShell } from "@/components/staff-shell";

export const metadata: Metadata = {
	title: "AI spend · Alethia staff",
	description: "Cross-tenant AI cost-of-serve rollup for Alethia staff.",
};

// Always fresh — this is a live cost monitor, not a cacheable page.
export const dynamic = "force-dynamic";

/**
 * The staff AI-spend dashboard (`/spend`). Gates on `getStaff()` (Cloudflare Access should
 * already have blocked non-staff — defense-in-depth), then rolls up the current calendar
 * month's AI cost-of-serve from `ai_usage_ledger` (per-org / per-user / per-model / daily,
 * cost_micros → USD) cross-tenant and renders the read-only dashboard on the server.
 */
export default async function AiSpendPage() {
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

	const now = new Date();
	// Current calendar month, UTC — the "$/month" window.
	const from = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
	);
	const windowLabel = from.toLocaleDateString("en-US", {
		month: "short",
		year: "numeric",
		timeZone: "UTC",
	});

	const rollup = await aiSpendRollup(getServiceDb(), from, now);

	return (
		<StaffShell staffEmail={staff.email} active="spend">
			<div className="mb-6">
				<h1 className="text-xl font-semibold">AI spend</h1>
				<p className="text-sm text-muted-foreground">
					Real cost-of-serve across all organizations this month, from the AI
					usage ledger. Read-only.
				</p>
			</div>
			<AiSpendDashboard rollup={rollup} windowLabel={windowLabel} />
		</StaffShell>
	);
}
