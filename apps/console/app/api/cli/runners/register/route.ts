// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { authorizeCli } from "@/lib/authz/guard";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, runners } from "@/lib/db/schema";
import { cliRunnerRegistrationResponse } from "@/lib/validations/cli-contract";
import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";

/**
 * Body of POST /api/cli/runners/register.
 *
 * `metadata` is deliberately NOT accepted. `runners.metadata` is
 * `jsonb().$type<RunnerMetadata>()` — a known shape whose fields (`deploy_config`,
 * `cloud_instance_id`) are server-managed: the fleet scaler correlates a DB runner to its VM
 * through `cloud_instance_id`, and `deploy_config` records what a DEPLOY_RUNNER job was given.
 * This route used to forward `metadata` straight from an untyped `req.json()` into that column, so a
 * caller could write arbitrary JSON into a typed field and set values the fleet controller reads. No
 * client has ever sent it (there was no CLI method until now), so dropping it breaks nothing.
 */
const registerRunnerBody = z.object({
	name: z.string().min(1).max(120),
	cloud_identity_id: z.string().uuid().optional(),
});

/**
 * Registers a SELF-OPERATED, user-brought runner and returns its bearer token once.
 *
 * `provisioning: "registered"` is what distinguishes this from `runner deploy`: nothing is
 * provisioned, the caller runs the runner themselves. That is the four-cloud answer that needs no
 * new Terraform — `runner deploy` renders `infra/templates/runner/`, which only has an `aws`
 * directory.
 *
 * Hardening, because this was the last `/api/cli` route on the raw seam:
 *  - `authorizeCli` replaces bare `verifyCliToken`, so the request is authorized against the
 *    `runner` resource and the actor's ACTIVE ORG is resolved rather than inferred from `sub`.
 *  - the body is a zod schema instead of a destructured `await req.json()`.
 *  - a `cloud_identity_id` is verified to belong to the actor's org — it used to be written
 *    unchecked, so a caller could attach a runner to another org's cloud identity by guessing a
 *    UUID.
 *  - the response goes through `cliJson`, so it cannot drift from the Go client's contract.
 */
export async function POST(req: Request) {
	const auth = await authorizeCli(req, "create", { type: "runner" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const parsed = registerRunnerBody.safeParse(
		await req.json().catch(() => null),
	);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid request body: name is required" },
			{ status: 400 },
		);
	}
	const { name, cloud_identity_id } = parsed.data;

	try {
		const db = getServiceDb();

		if (cloud_identity_id) {
			// Scoped by org, not just by id: an unscoped lookup would let a caller bind their runner
			// to a cloud identity they cannot see.
			const [ci] = await db
				.select({ id: cloudIdentities.id })
				.from(cloudIdentities)
				.where(
					and(
						eq(cloudIdentities.id, cloud_identity_id),
						eq(cloudIdentities.org_id, actor.orgId),
					),
				)
				.limit(1);
			if (!ci) {
				return NextResponse.json(
					{ error: "Cloud identity not found" },
					{ status: 400 },
				);
			}
		}

		// The token is returned ONCE and only its SHA-256 is stored, so a leak of the runners table
		// cannot yield a usable credential.
		const runnerToken = randomBytes(32).toString("hex");
		const tokenHash = createHash("sha256").update(runnerToken).digest("hex");

		const [runner] = await db
			.insert(runners)
			.values({
				user_id: actor.userId,
				// Explicit rather than left to the set_org_id trigger's backfill: the trigger is the
				// safety net, and a row whose tenancy depends on one is a row whose tenancy is implicit.
				org_id: actor.orgId,
				name,
				operator: "self",
				provisioning: "registered",
				cloud_identity_id: cloud_identity_id ?? null,
				token_hash: tokenHash,
			})
			.returning();
		if (!runner) {
			return NextResponse.json(
				{ error: "Failed to register runner" },
				{ status: 500 },
			);
		}

		return cliJson(
			cliRunnerRegistrationResponse,
			{ runner, runner_token: runnerToken },
			{ status: 201 },
		);
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
