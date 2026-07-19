// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: org-shared agent context with the ALETHIA_ORG_AGENT_CONTEXT_ENABLED flag ON.
// readAgentContext under withActorScope must (a) let a co-member read the shared org row
// (org_id = the real org), (b) PREFER that org row over a lingering legacy personal row during the
// transition, (c) fall back to the author's own legacy row only when no org row exists, and
// (d) never leak one member's personal legacy row to another. Seeded via the service connection;
// read through the RLS-enforced app connection. Skipped when the app role isn't distinct.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { agentContext } from "@/lib/db/schema";
import { readAgentContext } from "@/lib/ai/project-knowledge";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const M1 = randomUUID(); // author of a legacy personal org-level row
const M2 = randomUUID(); // a co-member who did NOT write anything
const ORG_OTHER = randomUUID();
const M3 = randomUUID();

const APP_ROLE_DISTINCT =
	(process.env.ALETHIA_APP_DATABASE_URL ?? "") !== "" &&
	process.env.ALETHIA_APP_DATABASE_URL !== process.env.ALETHIA_DATABASE_URL;

const M1_ACTOR = { userId: M1, orgId: ORG };
const M2_ACTOR = { userId: M2, orgId: ORG };
const M3_ACTOR = { userId: M3, orgId: ORG_OTHER };

describeIfDb("org-shared agent context (flag ON)", () => {
	let flagWas: string | undefined;
	beforeAll(() => {
		flagWas = process.env.ALETHIA_ORG_AGENT_CONTEXT_ENABLED;
		process.env.ALETHIA_ORG_AGENT_CONTEXT_ENABLED = "true";
	});
	afterAll(async () => {
		process.env.ALETHIA_ORG_AGENT_CONTEXT_ENABLED = flagWas;
		await getServiceDb()
			.delete(agentContext)
			.where(inArray(agentContext.org_id, [ORG, ORG_OTHER, M1, M3]));
	});
	afterEach(async () => {
		// Each test seeds its own org-level rows; clear between them (org-level row is unique per org).
		await getServiceDb()
			.delete(agentContext)
			.where(
				and(
					isNull(agentContext.project_id),
					inArray(agentContext.org_id, [ORG, ORG_OTHER, M1, M3]),
				),
			);
	});

	/** Seed an org-level (project_id NULL) context row with an explicit org_id + author. */
	async function seedOrgLevel(orgId: string, userId: string, instructions: string) {
		await getServiceDb()
			.insert(agentContext)
			.values({ user_id: userId, org_id: orgId, project_id: null, instructions });
	}

	it.skipIf(!APP_ROLE_DISTINCT)(
		"a co-member reads the shared org row (org_id = the real org)",
		async () => {
			await seedOrgLevel(ORG, M1, "org policy: require approval");
			const ctx = await readAgentContext(M2_ACTOR, null);
			expect(ctx?.instructions).toBe("org policy: require approval");
		},
	);

	it.skipIf(!APP_ROLE_DISTINCT)(
		"prefers the org row over a lingering legacy personal row",
		async () => {
			// M1 has BOTH an old personal row (org_id = M1) and the shared org row (org_id = ORG).
			await seedOrgLevel(M1, M1, "stale personal note");
			await seedOrgLevel(ORG, M1, "the real org policy");
			const ctx = await readAgentContext(M1_ACTOR, null);
			expect(ctx?.instructions).toBe("the real org policy"); // org row wins, not the personal one
		},
	);

	it.skipIf(!APP_ROLE_DISTINCT)(
		"falls back to the author's own legacy row when no org row exists",
		async () => {
			await seedOrgLevel(M1, M1, "my personal instructions");
			// The author still sees their legacy row (via the user_id RLS arm)…
			const own = await readAgentContext(M1_ACTOR, null);
			expect(own?.instructions).toBe("my personal instructions");
			// …but a co-member does NOT — a personal legacy row is private to its author.
			const other = await readAgentContext(M2_ACTOR, null);
			expect(other).toBeNull();
		},
	);

	it.skipIf(!APP_ROLE_DISTINCT)(
		"a different org's member sees none of this org's context",
		async () => {
			await seedOrgLevel(ORG, M1, "secret org policy");
			const leak = await readAgentContext(M3_ACTOR, null);
			expect(leak).toBeNull();
		},
	);
});
