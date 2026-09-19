// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { authorizeCli, userIdIsTheCaller } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { member, organization, organizationBilling } from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliOrgsResponse } from "@/lib/validations/cli-contract";

/**
 * Lists every organization the CLI caller is a member of, with their role and the
 * org's billing plan. `is_active` is true for the org matching the resolved active scope.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor, credential } = auth;

	try {
		const rows = await getServiceDb()
			.select({
				id: organization.id,
				name: organization.name,
				slug: organization.slug,
				role: member.role,
				plan: organizationBilling.plan,
			})
			.from(member)
			.innerJoin(organization, eq(member.organizationId, organization.id))
			.leftJoin(
				organizationBilling,
				eq(organizationBilling.organizationId, organization.id),
			)
			.where(
				// A SESSION lists every org the human belongs to — that is what `alethia org list`
				// is for, and how they pick one to switch to.
				//
				// A SERVICE TOKEN lists ONLY its pinned org (#4298). `actor.userId` is the MINTING
				// profile, so the unrestricted form returned every org that person belongs to, with
				// role and plan, through a credential pinned to one. The membership predicate stays
				// on top of the pin rather than being replaced by it: `authorizeCli` re-checks the
				// minter's membership on every request, and this keeps the row's `role` truthful
				// instead of inventing one for an org the profile has left.
				userIdIsTheCaller(credential)
					? eq(member.userId, actor.userId)
					: and(
							eq(member.userId, actor.userId),
							eq(organization.id, actor.orgId),
						),
			);

		const orgs = rows.map((r) => ({
			id: r.id,
			name: r.name,
			slug: r.slug ?? "",
			role: r.role,
			plan: r.plan ?? "community",
			is_active: r.id === actor.orgId,
		}));

		return cliJson(cliOrgsResponse, { orgs });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
