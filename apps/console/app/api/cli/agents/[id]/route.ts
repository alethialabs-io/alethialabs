// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/agents/:id — one agent identity, scoped to the caller's tenancy. A request for
// another org's agent id resolves to 404, never that org's persona/mission. Mirrors getAgent (web):
// the (user_id OR org_id) predicate is the tenancy wall (agent_identities has no RLS yet).

import { and, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authorizeCli, userIdIsTheCaller } from "@/lib/authz/guard";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { agentIdentities } from "@/lib/db/schema";
import { cliAgentResponse } from "@/lib/validations/cli-contract";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor, credential } = auth;
	const { id } = await params;

	try {
		const [a] = await getServiceDb()
			.select()
			.from(agentIdentities)
			.where(
				and(
					eq(agentIdentities.id, id),
					// #4298: the `user_id` arm is the CALLER's own id for a session, and the MINTING
					// profile's for a service token — so on a token this returned the minter's personal
					// and other-org agent identities through a credential pinned to one org. A token
					// sees the org arm alone; the pin is the whole of what it was issued for.
					userIdIsTheCaller(credential)
						? or(
								eq(agentIdentities.user_id, actor.userId), // authz-scope-ok: session caller's own globally-unique id; org_id arm scopes Teams
								eq(agentIdentities.org_id, actor.orgId),
							)
						: eq(agentIdentities.org_id, actor.orgId),
				),
			)
			.limit(1);
		if (!a) {
			return NextResponse.json({ error: "Agent not found" }, { status: 404 });
		}

		return cliJson(cliAgentResponse, {
			agent: {
				id: a.id,
				persona: a.persona,
				mission: a.mission,
				tool_scope: a.tool_scope,
				memory_namespace: a.memory_namespace,
				project_id: a.project_id,
				version: a.version,
				created_at: a.created_at.toISOString(),
				updated_at: a.updated_at.toISOString(),
			},
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
