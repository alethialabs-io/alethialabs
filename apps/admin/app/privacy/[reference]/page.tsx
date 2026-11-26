// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatDate } from "@repo/format";
import { SectionHeading } from "@repo/ui/section-heading";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type React from "react";
import { NotAuthorized } from "@/components/not-authorized";
import { PrivacyCaseActions } from "@/components/privacy/privacy-case-actions";
import { PrivacyStateBadge } from "@/components/privacy/privacy-state-badge";
import { StaffShell } from "@/components/staff-shell";
import { getStaff, isPlatformAdmin } from "@/lib/auth/staff";
import { loadPrivacyCase } from "../data";

export const metadata: Metadata = {
	title: "Privacy request · Alethia staff",
	description: "One data-subject request: its deadline, its ledger and its handling steps.",
};

export const dynamic = "force-dynamic";

/** One labelled fact about the case. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="space-y-0.5">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="text-sm">{children}</dd>
		</div>
	);
}

/**
 * One privacy case (`/privacy/<reference>`, #7222): what was asked and when it is due, the ledger
 * (every step, oldest first, with who took it), and — while the case is undecided — the handling
 * steps. Platform admins only, like the register. Dates are UTC: the deadline is a statutory date.
 */
export default async function PrivacyCasePage({
	params,
}: {
	params: Promise<{ reference: string }>;
}) {
	const staff = await getStaff();
	if (!staff || !isPlatformAdmin(staff.email)) return <NotAuthorized />;

	const { reference } = await params;
	const detail = await loadPrivacyCase(reference);
	if (!detail) notFound();
	const c = detail.case;
	const now = new Date();
	const overdue = !c.decidedAt && new Date(c.dueAt).getTime() < now.getTime();

	return (
		<StaffShell staffEmail={staff.email} active="privacy">
			<div className="space-y-6">
				<Link href="/privacy" className="text-sm text-muted-foreground hover:underline">
					← Privacy register
				</Link>

				<section className="space-y-3">
					<SectionHeading
						title={<span className="font-mono">{c.reference}</span>}
						description={`${c.kind} request`}
						actions={<PrivacyStateBadge state={c.state} />}
					/>
					<dl className="grid gap-3 rounded-lg border p-4 sm:grid-cols-3">
						<Fact label="Received">{formatDate(c.receivedAt, "date", "UTC")}</Fact>
						<Fact label="Due">
							<span className={overdue ? "font-medium text-destructive" : undefined}>
								{formatDate(c.dueAt, "date", "UTC")}
								{overdue ? " · overdue" : ""}
							</span>
						</Fact>
						<Fact label="Identity">
							{c.identityVerifiedAt
								? `verified ${formatDate(c.identityVerifiedAt, "date", "UTC")}`
								: "not verified"}
						</Fact>
						<Fact label="Account">
							{c.subjectUserId ? (
								<span className="font-mono text-xs">{c.subjectUserId}</span>
							) : (
								"no account matched"
							)}
						</Fact>
						<Fact label="Organization">
							{c.organizationId ? (
								<Link href={`/orgs/${c.organizationId}`} className="font-mono text-xs hover:underline">
									{c.organizationId}
								</Link>
							) : (
								"none (controller-level)"
							)}
						</Fact>
						<Fact label="Decided">
							{c.decidedAt ? formatDate(c.decidedAt, "date", "UTC") : "—"}
						</Fact>
						{c.extendedAt && (
							<Fact label="Extended">
								{formatDate(c.extendedAt, "date", "UTC")} — {c.extensionReason}
							</Fact>
						)}
						{c.legalHoldReason && <Fact label="Legal hold">{c.legalHoldReason}</Fact>}
						{c.refusalReason && <Fact label="Refusal grounds">{c.refusalReason}</Fact>}
					</dl>
				</section>

				{!c.decidedAt && (
					<section className="space-y-3">
						<SectionHeading title="Handle" />
						<PrivacyCaseActions
							state={{
								reference: c.reference,
								kind: c.kind,
								identityVerified: c.identityVerifiedAt !== null,
								extended: c.extendedAt !== null,
								onHold: c.legalHoldReason !== null,
								accountLinked: c.subjectUserId !== null,
							}}
						/>
					</section>
				)}

				<section className="space-y-3">
					<SectionHeading title="Ledger" description="Append-only; oldest first." />
					<ol className="space-y-2">
						{detail.events.map((e, i) => (
							<li key={`${e.at}-${i}`} className="rounded-lg border p-3 text-sm">
								<div className="flex flex-wrap items-baseline justify-between gap-2">
									<span className="font-mono text-xs">{e.kind}</span>
									<span className="text-xs text-muted-foreground">
										{formatDate(e.at, "datetime", "UTC")} UTC
										{e.actorEmail ? ` · ${e.actorEmail}` : ""}
									</span>
								</div>
								{e.summary && <p className="mt-1">{e.summary}</p>}
							</li>
						))}
					</ol>
				</section>
			</div>
		</StaffShell>
	);
}
