// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { deploymentMode } from "@/lib/billing/config";
import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { desc, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliRunnersResponse } from "@/lib/validations/cli-contract";

/**
 * Lists the addressed org's runners, plus the managed fleet's where the console shows it too.
 *
 * The CLI list follows the console's deployment rule for managed runners
 * (lib/rpc/procedures/runners.ts): they are listed on a self-managed deployment, where the operator
 * runs the fleet, and not on the hosted SaaS.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "runner" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const db = getServiceDb();
		const runnerRows = await db
			.select({
				id: runners.id,
				name: runners.name,
				operator: runners.operator,
				provisioning: runners.provisioning,
				supported_providers: runners.supported_providers,
				status: runners.status,
				last_heartbeat: runners.last_heartbeat,
				version: runners.version,
				is_default: runners.is_default,
				created_at: runners.created_at,
			})
			.from(runners)
			.where(
				deploymentMode() === "self-managed"
					? or(eq(runners.org_id, actor.orgId), eq(runners.operator, "managed"))
					: eq(runners.org_id, actor.orgId),
			)
			.orderBy(desc(runners.is_default), desc(runners.created_at));

		return cliJson(cliRunnersResponse, { runners: runnerRows });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
