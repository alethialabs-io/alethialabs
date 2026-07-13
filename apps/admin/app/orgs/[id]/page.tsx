// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getStaff, isPlatformAdmin } from "@/lib/auth/staff";
import { getOrgDetail } from "@/lib/platform/queries";
import { GrantEnterpriseForm } from "@/components/orgs/grant-enterprise-form";
import { NotAuthorized } from "@/components/not-authorized";
import { StaffShell } from "@/components/staff-shell";

export const metadata: Metadata = { title: "Org · Alethia staff" };
export const dynamic = "force-dynamic";

/** Operator org detail (`/orgs/[id]`): billing, members, contract history, and the grant form. */
export default async function OrgDetailPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const staff = await getStaff();
	if (!staff) return <NotAuthorized />;

	const { id } = await params;
	const org = await getOrgDetail(id);
	if (!org) notFound();

	const canAct = isPlatformAdmin(staff.email);
	const owner = org.members.find((m) => m.role === "owner");

	return (
		<StaffShell staffEmail={staff.email} active="orgs">
			<div className="mx-auto w-full max-w-4xl px-4 py-6">
				<Link href="/orgs" className="text-sm text-muted-foreground hover:underline">
					← Orgs
				</Link>
				<div className="mt-2 flex items-center gap-3">
					<h1 className="text-lg font-medium">{org.name}</h1>
					<span className="font-mono text-xs text-muted-foreground">/{org.slug}</span>
					<span className="rounded-full border px-2 py-0.5 text-xs capitalize">
						{org.billing?.plan ?? "community"}
					</span>
					<span className="text-xs text-muted-foreground capitalize">
						{org.billing?.status ?? "none"}
					</span>
				</div>

				<div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
					<div className="space-y-5">
						{/* Billing */}
						<section className="rounded-lg border p-4">
							<h2 className="mb-2 text-sm font-medium">Billing</h2>
							<dl className="space-y-1 text-sm">
								<Row k="Plan" v={org.billing?.plan ?? "community"} />
								<Row k="Status" v={org.billing?.status ?? "none"} />
								<Row k="Seats" v={org.billing?.seats?.toString() ?? "—"} />
								<Row
									k="Period end"
									v={org.billing?.currentPeriodEnd?.slice(0, 10) ?? "—"}
								/>
								<Row
									k="Stripe sub"
									v={org.billing?.stripeSubscriptionId ?? "— (off-Stripe / none)"}
								/>
							</dl>
						</section>

						{/* Members */}
						<section className="rounded-lg border p-4">
							<h2 className="mb-2 text-sm font-medium">
								Members ({org.members.length})
							</h2>
							<ul className="space-y-1 text-sm">
								{org.members.map((m) => (
									<li key={m.email} className="flex justify-between gap-2">
										<span>{m.name ?? m.email}</span>
										<span className="text-xs text-muted-foreground capitalize">
											{m.role}
										</span>
									</li>
								))}
								{org.members.length === 0 && (
									<li className="text-xs text-muted-foreground">
										No members yet (owner invitation pending).
									</li>
								)}
							</ul>
						</section>

						{/* Contract history */}
						<section className="rounded-lg border p-4">
							<h2 className="mb-2 text-sm font-medium">Contract history</h2>
							{org.contracts.length === 0 ? (
								<p className="text-xs text-muted-foreground">No contracts recorded.</p>
							) : (
								<ul className="space-y-2 text-sm">
									{org.contracts.map((c) => (
										<li key={c.id} className="rounded border p-2 text-xs">
											<div className="flex justify-between">
												<span className="font-medium capitalize">
													{c.plan} · {c.collectionMethod}
												</span>
												<span className="text-muted-foreground">
													{c.createdAt.slice(0, 10)}
												</span>
											</div>
											<div className="text-muted-foreground">
												{c.termStart.slice(0, 10)} →{" "}
												{c.termEnd?.slice(0, 10) ?? "open"} ·{" "}
												{c.amountCents != null
													? `${(c.amountCents / 100).toLocaleString()} ${c.currency}`
													: "—"}{" "}
												· by {c.createdByEmail}
												{c.revokedAt && " · REVOKED"}
											</div>
										</li>
									))}
								</ul>
							)}
						</section>
					</div>

					{/* Grant Enterprise (Flow A) */}
					{canAct ? (
						<GrantEnterpriseForm orgId={org.id} ownerEmail={owner?.email ?? ""} />
					) : (
						<p className="text-sm text-muted-foreground">
							Operator actions require the platform-admin allowlist.
						</p>
					)}
				</div>
			</div>
		</StaffShell>
	);
}

function Row({ k, v }: { k: string; v: string }) {
	return (
		<div className="flex justify-between gap-3">
			<dt className="text-muted-foreground">{k}</dt>
			<dd className="truncate font-mono text-xs">{v}</dd>
		</div>
	);
}
