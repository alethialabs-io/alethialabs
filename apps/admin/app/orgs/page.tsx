// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { getStaff, isPlatformAdmin } from "@/lib/auth/staff";
import { searchOrgs } from "@/lib/platform/queries";
import { NotAuthorized } from "@/components/not-authorized";
import { OrgSearch } from "@/components/orgs/org-search";
import { StaffShell } from "@/components/staff-shell";

export const metadata: Metadata = {
	title: "Orgs · Alethia staff",
	description: "Cross-tenant org directory and Enterprise onboarding for Alethia operators.",
};

export const dynamic = "force-dynamic";

/**
 * The operator Orgs directory (`/orgs`). Reads are gated on `getStaff()`; the Enterprise-grant /
 * create-org actions on the detail pages additionally gate on `assertPlatformAdmin()`. A search box
 * (name / slug / owner email) filters server-side.
 */
export default async function OrgsPage({
	searchParams,
}: {
	searchParams: Promise<{ q?: string }>;
}) {
	const staff = await getStaff();
	if (!staff) return <NotAuthorized />;

	const { q } = await searchParams;
	const orgs = await searchOrgs(q);
	const canAct = isPlatformAdmin(staff.email);

	return (
		<StaffShell staffEmail={staff.email} active="orgs">
			<div className="mx-auto w-full max-w-5xl px-4 py-6">
				<div className="mb-4 flex items-center justify-between gap-4">
					<div>
						<h1 className="text-lg font-medium">Organizations</h1>
						<p className="text-sm text-muted-foreground">
							{canAct
								? "Search an org to manage its plan, or create a new Enterprise org."
								: "Read-only — operator actions require the platform-admin allowlist."}
						</p>
					</div>
					{canAct && (
						<Link
							href="/orgs/new"
							className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90"
						>
							New Enterprise org
						</Link>
					)}
				</div>

				<OrgSearch initialQuery={q ?? ""} />

				<div className="mt-4 overflow-hidden rounded-lg border">
					<table className="w-full text-sm">
						<thead className="bg-muted/40 text-left text-xs text-muted-foreground">
							<tr>
								<th className="px-3 py-2 font-medium">Org</th>
								<th className="px-3 py-2 font-medium">Owner</th>
								<th className="px-3 py-2 font-medium">Plan</th>
								<th className="px-3 py-2 font-medium">Status</th>
							</tr>
						</thead>
						<tbody>
							{orgs.length === 0 ? (
								<tr>
									<td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
										{q ? "No matching organizations." : "No organizations."}
									</td>
								</tr>
							) : (
								orgs.map((o) => (
									<tr key={o.id} className="border-t hover:bg-muted/30">
										<td className="px-3 py-2">
											<Link href={`/orgs/${o.id}`} className="font-medium hover:underline">
												{o.name}
											</Link>
											<span className="ml-2 font-mono text-xs text-muted-foreground">
												/{o.slug}
											</span>
										</td>
										<td className="px-3 py-2 text-muted-foreground">
											{o.ownerEmail ?? "—"}
										</td>
										<td className="px-3 py-2">
											<span className="rounded-full border px-2 py-0.5 text-xs capitalize">
												{o.plan}
											</span>
										</td>
										<td className="px-3 py-2 text-muted-foreground capitalize">
											{o.status}
										</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			</div>
		</StaffShell>
	);
}
