// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import type { CliCredential } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import type { Actor } from "@/lib/authz/types";
import type { Db, Tx } from "@/lib/db";
import { runners } from "@/lib/db/schema";

/**
 * The `personalOrgId` to hand {@link assertRunnerInOrg} for a CLI caller — `undefined` for a service
 * token (#4298).
 *
 * `personalOrgId` admits a runner whose `org_id` equals the CALLER's own id, which is the pre-#3874
 * compatibility path. For a session that is the human's personal org and the arm is correct. For a
 * service token `actor.userId` is the MINTING profile, so passing it admitted the minter's personal
 * runner: a token pinned to org T could assign an org-T job to it, and `claim_next_job`'s legacy
 * lifecycle arm would then execute that job with the minter's personal cloud identity. A pin that
 * bounds the job but not the executor bounds nothing.
 *
 * A `switch` over the closed union rather than a ternary, in one place rather than at each call
 * site: a third credential kind becomes a type error here, and the narrow answer cannot be reached
 * by forgetting to ask.
 */
export function personalRunnerArm(
	actor: Actor,
	credential: CliCredential,
): string | undefined {
	switch (credential) {
		case "service_token":
			return undefined;
		case "session":
			return actor.userId;
	}
}

/**
 * Validates that a client-supplied runner can execute a job for the active org.
 *
 * Managed runners belong to the shared pool and have no org. `personalOrgId`
 * admits only a caller-owned runner written before #3874 stamped CLI runners
 * with the active org; claim-time compatibility remains independently narrowed
 * to lifecycle jobs created by that same owner.
 */
export async function assertRunnerInOrg(
	db: Db | Tx,
	runnerId: string,
	orgId: string,
	personalOrgId?: string,
): Promise<void> {
	const [row] = await db
		.select({ org_id: runners.org_id })
		.from(runners)
		.where(eq(runners.id, runnerId))
		.limit(1);

	const admitted =
		row !== undefined &&
		(row.org_id === null ||
			row.org_id === orgId ||
			(personalOrgId !== undefined && row.org_id === personalOrgId));

	if (!admitted) {
		throw new ForbiddenError(
			"deploy",
			{ type: "runner", id: runnerId },
			"runner not found or not in caller's org",
		);
	}
}
