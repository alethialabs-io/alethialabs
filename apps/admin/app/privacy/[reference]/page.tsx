// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDate } from "@repo/format";
import { NotAuthorized } from "@/components/not-authorized";
import { ReasonedDecisionForm, SimpleDecisionForm } from "@/components/privacy/privacy-forms";
import { StaffShell } from "@/components/staff-shell";
import { getStaff, isPlatformAdmin } from "@/lib/auth/staff";
import { isOverdue, privacyCaseDetail } from "@/lib/privacy/queries";

export const metadata: Metadata = { title: "Privacy request · Alethia staff" };
export const dynamic = "force-dynamic";

/** The kinds fulfilled by an export of the account's data. */
const EXPORT_KINDS = new Set(["access", "export", "portability"]);

/**
 * One privacy request (`/privacy/[reference]`): its facts, its full ledger, and — for a platform
 * admin, while it is undecided — the decisions: verify identity, fulfil (an erasure, or an export
 * for access / export / portability), extend once, hold, or refuse with a reason.
 */
export default async function PrivacyCasePage({
	params,
}: {
	params: Promise<{ reference: string }>;
}) {
	const staff = await getStaff();
	if (!staff) return <NotAuthorized />;
	const { reference } = await params;
	if (!/^DSR-[0-9A-F]{8}$/.test(reference)) notFound();
	const c = await privacyCaseDetail(reference);
	if (!c) notFound();
	const canAct = isPlatformAdmin(staff.email) && c.decidedAt === null;
	const overdue = isOverdue(c, new Date());
	const fulfillable = c.kind === "erasure" || EXPORT_KINDS.has(c.kind);

	return (
		<StaffShell staffEmail={staff.email} active="privacy">
			<Link href="/privacy" className="text-sm text-muted-foreground hover:underline">
				← Privacy
			</Link>
			<div className="mt-2 flex flex-wrap items-center gap-3">
				<span className="font-mono text-lg font-medium">{c.reference}</span>
				<span className="rounded-full border px-2 py-0.5 text-xs capitalize">{c.kind}</span>
				<span className="text-xs text-muted-foreground">{c.state}</span>
				{overdue ? <span className="text-xs font-medium text-destructive">overdue</span> : null}
			</div>

			<dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
				<Fact k="Subject" v={c.subjectEmail ?? "no account"} />
				<Fact k="Raised in" v={c.organizationId ? "an organization (its admins decide it)" : "no organization"} />
				<Fact k="Received" v={formatDate(c.receivedAt, "datetime")} />
				<Fact k="Due" v={`${formatDate(c.dueAt)}${c.extendedAt ? " (extended)" : ""}`} />
				<Fact k="Identity" v={c.identityVerifiedAt ? `verified ${formatDate(c.identityVerifiedAt)}` : "not verified"} />
				<Fact k="Scheduled erasure" v={c.scheduledFor ? formatDate(c.scheduledFor, "datetime") : "—"} />
				<Fact k="Legal hold" v={c.legalHoldReason ?? "—"} />
				<Fact k="Refusal" v={c.refusalReason ?? "—"} />
			</dl>

			{canAct ? (
				<div className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-2">
					{!c.identityVerifiedAt ? (
						<SimpleDecisionForm
							reference={c.reference}
							action="verify"
							label="Verify identity"
							hint="Only after a one-time message to the account address, or equivalent proportionate evidence."
						/>
					) : null}
					{fulfillable ? (
						<SimpleDecisionForm
							reference={c.reference}
							action="fulfil"
							label={c.kind === "erasure" ? "Fulfil the erasure" : "Send the export"}
							hint={
								c.kind === "erasure"
									? "Erases the account now. Refused while an organization only the subject can reach still has resources."
									: "Builds the account's data export and emails the account a 72-hour link."
							}
						/>
					) : null}
					{!c.extendedAt ? (
						<ReasonedDecisionForm
							reference={c.reference}
							action="extend"
							label="Extend by two months"
							hint="Once only, for a complex request. The subject must be told why within the first month."
						/>
					) : null}
					<ReasonedDecisionForm
						reference={c.reference}
						action="hold"
						label="Apply a legal hold"
						hint="Pauses the destructive half. It does not refuse the request."
					/>
					<ReasonedDecisionForm
						reference={c.reference}
						action="refuse"
						label="Refuse"
						hint="State the grounds, and that the subject may complain to the supervisory authority (20 characters or more)."
					/>
				</div>
			) : null}

			<section className="mt-6">
				<p className="mb-2 text-sm font-medium">History</p>
				<ol className="space-y-2 border-l pl-4 text-sm">
					{c.events.map((e) => (
						<li key={e.id}>
							<p className="text-xs text-muted-foreground">
								{formatDate(e.at, "datetime")} · {e.kind} · {e.actorEmail ?? "automated"}
							</p>
							<p>{e.summary}</p>
						</li>
					))}
				</ol>
			</section>
		</StaffShell>
	);
}

/** One fact of the case. */
function Fact({ k, v }: { k: string; v: string }) {
	return (
		<div className="flex gap-2">
			<dt className="w-36 shrink-0 text-muted-foreground">{k}</dt>
			<dd className="break-words">{v}</dd>
		</div>
	);
}
