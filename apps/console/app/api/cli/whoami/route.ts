// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import {
	member,
	organization,
	organizationBilling,
	runners,
	user,
} from "@/lib/db/schema";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { whoamiWire } from "@/lib/validations/cli-contract";

/**
 * Returns the CLI caller's resolved identity: the user, their active organization
 * (null in the personal scope), and the active org's default runner (null when none).
 * The active org is the scope resolved by the optional `X-Alethia-Org` header.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const db = getServiceDb();

		const [u] = await db
			.select({ id: user.id, email: user.email, name: user.name })
			.from(user)
			.where(eq(user.id, actor.userId))
			.limit(1);
		if (!u) {
			return NextResponse.json({ error: "User not found" }, { status: 404 });
		}

		// Active org — only when the scope is a real organization (not the personal org,
		// where orgId === userId and there is no organization row).
		let activeOrg: {
			id: string;
			name: string;
			slug: string;
			role: string;
			plan: string;
			is_active: boolean;
		} | null = null;
		if (actor.orgId !== actor.userId) {
			const [org] = await db
				.select({
					id: organization.id,
					name: organization.name,
					slug: organization.slug,
					role: member.role,
					plan: organizationBilling.plan,
				})
				.from(organization)
				.leftJoin(
					member,
					and(
						eq(member.organizationId, organization.id),
						eq(member.userId, actor.userId),
					),
				)
				.leftJoin(
					organizationBilling,
					eq(organizationBilling.organizationId, organization.id),
				)
				.where(eq(organization.id, actor.orgId))
				.limit(1);
			if (org) {
				activeOrg = {
					id: org.id,
					name: org.name,
					slug: org.slug ?? "",
					role: org.role ?? "member",
					plan: org.plan ?? "community",
					is_active: true,
				};
			}
		}

		const [defaultRunner] = await db
			.select({ id: runners.id, name: runners.name })
			.from(runners)
			.where(and(eq(runners.org_id, actor.orgId), eq(runners.is_default, true)))
			.limit(1);

		return cliJson(whoamiWire, {
			user: { id: u.id, email: u.email, name: u.name ?? "" },
			active_org: activeOrg,
			default_runner: defaultRunner ?? null,
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
