// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { getStaff, isPlatformAdmin } from "@/lib/auth/staff";
import { CreateOrgForm } from "@/components/orgs/create-org-form";
import { NotAuthorized } from "@/components/not-authorized";
import { StaffShell } from "@/components/staff-shell";

export const metadata: Metadata = { title: "New Enterprise org · Alethia staff" };
export const dynamic = "force-dynamic";

/** Flow B page (`/orgs/new`): create a new Enterprise org. Operator-only. */
export default async function NewOrgPage() {
	const staff = await getStaff();
	if (!staff) return <NotAuthorized />;
	if (!isPlatformAdmin(staff.email)) {
		return (
			<StaffShell staffEmail={staff.email} active="orgs">
				<div className="mx-auto w-full max-w-2xl px-4 py-6">
					<p className="text-sm text-muted-foreground">
						Creating orgs requires the platform-admin allowlist.
					</p>
				</div>
			</StaffShell>
		);
	}

	return (
		<StaffShell staffEmail={staff.email} active="orgs">
			<div className="mx-auto w-full max-w-2xl px-4 py-6">
				<Link href="/orgs" className="text-sm text-muted-foreground hover:underline">
					← Orgs
				</Link>
				<h1 className="mt-2 mb-1 text-lg font-medium">New Enterprise org</h1>
				<p className="mb-4 text-sm text-muted-foreground">
					Creates the org shell, invites the owner, and applies the Enterprise plan. The
					owner gets access when they accept the invite.
				</p>
				<CreateOrgForm />
			</div>
		</StaffShell>
	);
}
