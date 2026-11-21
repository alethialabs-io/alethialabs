// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { formatDate } from "@repo/format";
import { NotAuthorized } from "@/components/not-authorized";
import { OpenCaseForm } from "@/components/privacy/privacy-forms";
import { StaffShell } from "@/components/staff-shell";
import { getStaff, isPlatformAdmin } from "@/lib/auth/staff";
import { listPrivacyCases } from "@/lib/privacy/queries";

export const metadata: Metadata = {
	title: "Privacy · Alethia staff",
	description: "The data-subject request queue: verify, decide and fulfil privacy requests.",
};
export const dynamic = "force-dynamic";

/**
 * The staff privacy queue (`/privacy`): every open data-subject request, most urgent first, with
 * the overdue ones flagged — the controller-level cases (self-serve and emailed requests) that no
 * organization's admins can decide in the console. Reading needs `getStaff()`; every decision
 * (on the case page) and opening a case need the platform-admin allowlist.
 */
export default async function PrivacyQueuePage({
	searchParams,
}: {
	searchParams: Promise<{ scope?: string }>;
}) {
	const staff = await getStaff();
	if (!staff) return <NotAuthorized />;
	const { scope } = await searchParams;
	const showAll = scope === "all";
	const cases = await listPrivacyCases(showAll ? "all" : "open");
	const canAct = isPlatformAdmin(staff.email);
	const overdue = cases.filter((c) => c.overdue).length;

	return (
		<StaffShell staffEmail={staff.email} active="privacy">
			<div className="mb-4 flex items-center justify-between gap-4">
				<p className="text-sm text-muted-foreground">
					{cases.length} {showAll ? "requests" : "open requests"}
					{overdue > 0 ? ` · ${overdue} overdue` : ""}
				</p>
				<Link href={showAll ? "/privacy" : "/privacy?scope=all"} className="text-sm hover:underline">
					{showAll ? "Show open only" : "Show all"}
				</Link>
			</div>

			{canAct ? <OpenCaseForm /> : null}

			<div className="mt-4 overflow-hidden rounded-lg border">
				<table className="w-full text-sm">
					<thead className="bg-muted/40 text-left text-xs text-muted-foreground">
						<tr>
							<th className="px-3 py-2 font-medium">Reference</th>
							<th className="px-3 py-2 font-medium">Kind</th>
							<th className="px-3 py-2 font-medium">Subject</th>
							<th className="px-3 py-2 font-medium">State</th>
							<th className="px-3 py-2 font-medium">Due</th>
						</tr>
					</thead>
					<tbody>
						{cases.length === 0 ? (
							<tr>
								<td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
									{showAll ? "No privacy requests." : "No open privacy requests."}
								</td>
							</tr>
						) : (
							cases.map((c) => (
								<tr key={c.reference} className="border-t hover:bg-muted/30">
									<td className="px-3 py-2">
										<Link href={`/privacy/${c.reference}`} className="font-mono hover:underline">
											{c.reference}
										</Link>
										{c.tenantCase ? (
											<span className="ml-2 text-xs text-muted-foreground">org case</span>
										) : null}
									</td>
									<td className="px-3 py-2 capitalize">{c.kind}</td>
									<td className="px-3 py-2 text-muted-foreground">{c.subjectEmail ?? "no account"}</td>
									<td className="px-3 py-2">
										<span className="rounded-full border px-2 py-0.5 text-xs">{c.state}</span>
										{c.scheduledFor ? (
											<span className="ml-2 text-xs text-muted-foreground">
												runs {formatDate(c.scheduledFor)}
											</span>
										) : null}
										{c.legalHold ? <span className="ml-2 text-xs">held</span> : null}
										{!c.identityVerified ? (
											<span className="ml-2 text-xs text-muted-foreground">unverified</span>
										) : null}
									</td>
									<td className="px-3 py-2">
										<span className={c.overdue ? "font-medium text-destructive" : ""}>
											{formatDate(c.dueAt)}
										</span>
										{c.overdue ? <span className="ml-2 text-xs text-destructive">overdue</span> : null}
									</td>
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>
		</StaffShell>
	);
}
