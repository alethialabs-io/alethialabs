// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { formatDate } from "@repo/format";
import { getStaff, isPlatformAdmin } from "@/lib/auth/staff";
import { EarlyAccessRequestActions } from "@/components/early-access/request-actions";
import { NotAuthorized } from "@/components/not-authorized";
import { StaffShell } from "@/components/staff-shell";
import { type EarlyAccessRow, listEarlyAccessRequests } from "./data";

export const metadata: Metadata = {
	title: "Early Access · Alethia staff",
	description: "Complimentary Early Access requests from EU businesses with a VAT number.",
};

export const dynamic = "force-dynamic";

/** What the VIES column says for each verdict. */
const VIES_LABEL: Record<EarlyAccessRow["vies"], string> = {
	valid: "valid",
	invalid: "NOT valid",
	unchecked: "unchecked",
};

/**
 * The staff Early Access page (`/early-access`, EA-3 #7325): every complimentary grant request, what
 * VIES said, and — for platform admins — Grant, Decline and Converted. Reads gate on `getStaff()`;
 * the actions gate on `assertPlatformAdmin()` and are audited.
 *
 * The Art. 97a reminder is on the page as well as in the alert: a grant is free, but the day a
 * granted business commits to pay, the registration must be filed before anything is billed.
 */
export default async function EarlyAccessPage() {
	const staff = await getStaff();
	if (!staff) return <NotAuthorized />;

	const requests = await listEarlyAccessRequests();
	const canAct = isPlatformAdmin(staff.email);

	return (
		<StaffShell staffEmail={staff.email} active="early-access">
			<div className="mb-4 space-y-1">
				<h1 className="text-lg font-medium">Early Access requests</h1>
				<p className="text-sm text-muted-foreground">
					A grant is complimentary: no Stripe object, nothing owed, and it lapses at its end date. Art.
					97a must be filed when a client commits to pay; billing starts only after the registration,
					going forward.
				</p>
			</div>

			<div className="overflow-hidden rounded-lg border">
				<table className="w-full text-sm">
					<thead className="bg-muted/40 text-left text-xs text-muted-foreground">
						<tr>
							<th className="px-3 py-2 font-medium">Org</th>
							<th className="px-3 py-2 font-medium">VAT number</th>
							<th className="px-3 py-2 font-medium">Plan</th>
							<th className="px-3 py-2 font-medium">Status</th>
							<th className="px-3 py-2 font-medium">Decision</th>
						</tr>
					</thead>
					<tbody>
						{requests.length === 0 ? (
							<tr>
								<td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
									No requests yet.
								</td>
							</tr>
						) : (
							requests.map((r) => (
								<tr key={r.id} className="border-t align-top">
									<td className="px-3 py-2">
										<Link href={`/orgs/${r.organizationId}`} className="font-medium hover:underline">
											{r.orgName ?? r.organizationId}
										</Link>
										{r.orgSlug && (
											<span className="ml-2 font-mono text-xs text-muted-foreground">/{r.orgSlug}</span>
										)}
										<div className="text-xs text-muted-foreground">
											filed {formatDate(r.createdAt, "datetime")}
										</div>
										{r.note && <p className="mt-1 text-xs text-muted-foreground">“{r.note}”</p>}
									</td>
									<td className="px-3 py-2">
										<div className="font-mono text-xs">{r.vatId}</div>
										<div className="text-xs text-muted-foreground">
											{r.country} · VIES {VIES_LABEL[r.vies]}
										</div>
										{r.viesName && <div className="text-xs text-muted-foreground">{r.viesName}</div>}
										{r.viesAddress && (
											<div className="text-xs text-muted-foreground">{r.viesAddress}</div>
										)}
										{r.viesRequestId && (
											<div className="font-mono text-xs text-muted-foreground">
												consultation {r.viesRequestId}
											</div>
										)}
									</td>
									<td className="px-3 py-2 font-mono text-xs">{r.plan}</td>
									<td className="px-3 py-2 capitalize">{r.status}</td>
									<td className="w-72 px-3 py-2">
										{r.decidedAt && (
											<div className="mb-2 text-xs text-muted-foreground">
												{r.decidedByEmail} · {formatDate(r.decidedAt, "datetime")}
												{r.decisionReason && <div>“{r.decisionReason}”</div>}
											</div>
										)}
										{canAct && (r.status === "open" || r.status === "granted") && (
											<EarlyAccessRequestActions requestId={r.id} status={r.status} />
										)}
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
