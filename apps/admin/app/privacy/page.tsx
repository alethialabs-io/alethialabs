// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatDate } from "@repo/format";
import { EmptyState } from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { SectionHeading } from "@repo/ui/section-heading";
import type { Metadata } from "next";
import Link from "next/link";
import { NotAuthorized } from "@/components/not-authorized";
import { OpenPrivacyCaseForm } from "@/components/privacy/open-privacy-case-form";
import { PrivacyCaseTable } from "@/components/privacy/privacy-case-table";
import { StaffShell } from "@/components/staff-shell";
import { getStaff, isPlatformAdmin } from "@/lib/auth/staff";
import { loadPrivacyRegister } from "./data";

export const metadata: Metadata = {
	title: "Privacy · Alethia staff",
	description: "Data-subject requests: record, verify, extend, hold, fulfil or refuse.",
};

export const dynamic = "force-dynamic";

/**
 * The privacy register (`/privacy`, #7222): every overdue request first — `overduePrivacyCases()`'s
 * question asked for the whole deployment — then every open case, a form to record a request that
 * arrived by email, and the recently decided.
 *
 * PLATFORM ADMINS ONLY, reads included. Unlike the Orgs and Early Access pages, being support staff
 * is not enough to READ here: a privacy register says who asked to be erased, and the controller's
 * decisions on it are the act-capable allowlist's to see.
 */
export default async function PrivacyPage() {
	const staff = await getStaff();
	if (!staff || !isPlatformAdmin(staff.email)) return <NotAuthorized />;

	const register = await loadPrivacyRegister();
	const now = new Date();
	const today = now.toISOString().slice(0, 10);

	return (
		<StaffShell staffEmail={staff.email} active="privacy">
			<div className="space-y-6">
				<PageToolbar description="Requests that arrive at the privacy inbox are recorded here, and every case is decided here. Each step goes to the case's ledger and the platform audit trail." />

				<section className="space-y-3">
					<SectionHeading
						title="Overdue"
						description="Undecided past the stored deadline, which already includes any extension."
					/>
					{register.overdue.length === 0 ? (
						<EmptyState title="Nothing overdue" />
					) : (
						<ul className="space-y-1 text-sm">
							{register.overdue.map((o) => (
								<li key={o.reference}>
									<Link href={`/privacy/${o.reference}`} className="font-mono hover:underline">
										{o.reference}
									</Link>{" "}
									<span className="text-muted-foreground">
										{o.kind} · {o.state.replace("_", " ")} · was due{" "}
										{formatDate(o.dueAt, "date", "UTC")}
									</span>
								</li>
							))}
						</ul>
					)}
				</section>

				<section className="space-y-3">
					<SectionHeading
						title="Record an emailed request"
						description="The address is hashed and never stored in the clear. The clock starts on the day it arrived."
					/>
					<OpenPrivacyCaseForm today={today} />
				</section>

				<section className="space-y-3">
					<SectionHeading title="Open" description="Soonest deadline first." />
					{register.open.length === 0 ? (
						<EmptyState title="No open requests" />
					) : (
						<PrivacyCaseTable rows={register.open} now={now} />
					)}
				</section>

				<section className="space-y-3">
					<SectionHeading title="Recently decided" description="The 50 most recent decisions." />
					{register.decided.length === 0 ? (
						<EmptyState title="No decided requests" />
					) : (
						<PrivacyCaseTable rows={register.decided} decided now={now} />
					)}
				</section>
			</div>
		</StaffShell>
	);
}
