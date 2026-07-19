// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/agents — the caller's agent identities (machine/agent personas). Gated on org
// `view`; org-scoped via the SAME predicate the web listAgents uses — (user_id = caller) OR
// (org_id = caller's org) — since agent_identities carries no RLS and a nullable org_id. Both keys
// are the caller's, so neither arm can match another tenant's row.

import { desc, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authorizeCli } from "@/lib/authz/guard";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { agentIdentities } from "@/lib/db/schema";
import { cliAgentsResponse } from "@/lib/validations/cli-contract";

export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const rows = await getServiceDb()
			.select()
			.from(agentIdentities)
			.where(
				// The (user_id OR org_id) scope mirrors the web listAgents: agent_identities has no
				// RLS/org trigger, so both the caller's own user_id and their org_id are the tenancy wall.
				or(
					eq(agentIdentities.user_id, actor.userId), // authz-scope-ok: caller's own globally-unique id; org_id arm scopes Teams
					eq(agentIdentities.org_id, actor.orgId),
				),
			)
			.orderBy(desc(agentIdentities.created_at));

		return cliJson(cliAgentsResponse, {
			agents: rows.map((a) => ({
				id: a.id,
				persona: a.persona,
				mission: a.mission,
				tool_scope: a.tool_scope,
				memory_namespace: a.memory_namespace,
				project_id: a.project_id,
				version: a.version,
				created_at: a.created_at.toISOString(),
				updated_at: a.updated_at.toISOString(),
			})),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
