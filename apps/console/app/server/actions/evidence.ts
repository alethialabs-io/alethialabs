"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Evidence surface server action (day-2 "keep proving it"): the org-wide verification +
// drift + waiver roll-up. Read-only; scoped to the actor's active org (never a
// client-supplied org id). Personal scope has no org-level evidence → empty roll-up.

import { currentActor } from "@/lib/authz/guard";
import { type OrgEvidence, queryOrgEvidence } from "@/lib/queries/evidence";

/** The active org's evidence roll-up (verify verdicts, drift posture, active waivers). */
export async function getOrgEvidence(): Promise<OrgEvidence> {
	const actor = await currentActor();
	// Personal scope (orgId === userId) has no org projects/environments to prove.
	if (actor.orgId === actor.userId) {
		return {
			rows: [],
			waivers: [],
			summary: {
				environments: 0,
				verified: 0,
				warning: 0,
				failing: 0,
				notEvaluable: 0,
				unverified: 0,
				inSync: 0,
				drifted: 0,
				driftUnknown: 0,
				activeWaivers: 0,
			},
		};
	}
	return queryOrgEvidence(actor.orgId);
}
