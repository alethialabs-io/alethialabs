// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { and, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { projectEnvironments } from "@/lib/db/schema";

/**
 * Refuse an environment that does not belong to `projectId`.
 *
 * The protection-rule entry points authorize against a PROJECT
 * (`authorize("edit", { type: "project", id })`) and are then handed an ENVIRONMENT id by the
 * caller. Nothing else ties the two together, and the two things that look like they would are
 * both the wrong shape:
 *
 *  - RLS is not that wall. The policy on `environment_protection_rules` scopes to the ORG —
 *    `project_id IN (SELECT id FROM projects WHERE user_id = … OR org_id = …)` — so every project
 *    in the actor's org satisfies it. It separates tenants, not projects.
 *  - `environment_protection_rules_env_key` is `UNIQUE(environment_id)`, so an upsert whose
 *    `ON CONFLICT` target is `environment_id` does not fail on a foreign environment — it
 *    OVERWRITES whichever project's row already owns it.
 *
 * `authorize` is per-resource (the PDP takes a specific id, and `grants` carries
 * `resource_type`/`resource_id` with allow/deny effects), so "edit on project A, not on project B"
 * is a state the model can genuinely be in. Without this check an org member with edit on ANY one
 * project could rewrite another project's promotion gates — `require_approval`,
 * `require_verify_pass`, `require_predecessor`, the soak window, the cost threshold — which
 * {@link file://./gates.ts} evaluates when a promotion's PLAN completes. That is an approval
 * bypass, not an information leak.
 *
 * It lives HERE rather than in the `"use server"` module that uses it: every export of a
 * `"use server"` file is a callable server action, so exporting a security helper from there to
 * make it testable would widen the RPC surface to make a check reachable. Ordinary module, ordinary
 * import, and the integration suite can execute it directly.
 *
 * @param tx an actor-scoped transaction
 * @param projectId the project the caller was authorized against
 * @param envId the environment the caller supplied
 * @throws when the environment does not belong to that project (or does not exist)
 */
export async function assertEnvInProject(
	tx: Tx,
	projectId: string,
	envId: string,
): Promise<void> {
	const [row] = await tx
		.select({ id: projectEnvironments.id })
		.from(projectEnvironments)
		.where(
			and(
				eq(projectEnvironments.id, envId),
				eq(projectEnvironments.project_id, projectId),
			),
		)
		.limit(1);
	if (!row) throw new Error("Unknown environment for this project");
}
