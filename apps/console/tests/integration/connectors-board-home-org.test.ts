// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6124, review A-1): the connectors board at an org lists only cloud accounts HOMED in
// that org. A personal account the caller created in ANOTHER org is theirs under the `scoped_all`
// RLS policy — but every write on the board acts within the addressed org and would refuse it, so
// listing it would offer Re-verify / Rename / Remove that can only dead-end.
//
// Real Postgres with RLS (`withScope`); the PDP (only `canManage` reads it) and the git-token
// refresher are the boundaries stubbed.

import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeIfDb } from "./db";

vi.mock("@/lib/authz", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz")>()),
	getPdp: () => ({ can: async () => ({ allowed: true }) }),
}));
vi.mock("@/app/server/actions/identities", () => ({ getValidProviderToken: vi.fn(async () => null) }));

import type { Actor } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";
import { readConnectorsBoard } from "@/lib/rpc/procedures/connectors";

const ORG_X = randomUUID();
const ORG_Y = randomUUID();
const CALLER = randomUUID();

const seeded = { homedHere: "", homedElsewhere: "" };

/** Inserts one configured AWS personal identity of CALLER, homed in `orgId`. */
async function seedPersonal(orgId: string): Promise<string> {
	const [row] = await getServiceDb()
		.insert(cloudIdentities)
		.values({
			user_id: CALLER,
			org_id: orgId,
			scope: "personal",
			provider: "aws",
			name: `it-6124-home-${orgId.slice(0, 8)}`,
			credentials: { role_arn: "arn:aws:iam::123456789012:role/it-6124-home" },
			status: "connected",
			is_verified: true,
		})
		.returning({ id: cloudIdentities.id });
	return row.id;
}

/** Every cloud account id the board lists, across connectors. */
function listedIds(board: Awaited<ReturnType<typeof readConnectorsBoard>>): string[] {
	return board.integrations.flatMap((i) => (i.accounts ?? []).map((a) => a.identityId));
}

describeIfDb("connectors board — only accounts homed in the addressed org", () => {
	beforeAll(async () => {
		seeded.homedHere = await seedPersonal(ORG_X);
		seeded.homedElsewhere = await seedPersonal(ORG_Y);
	});

	afterAll(async () => {
		await getServiceDb()
			.delete(cloudIdentities)
			.where(inArray(cloudIdentities.id, Object.values(seeded).filter(Boolean)));
	});

	it("lists the caller's personal account homed here, and not the one homed in another org", async () => {
		const actor: Actor = { userId: CALLER, orgId: ORG_X, credential: "session" };
		const ids = listedIds(await readConnectorsBoard(actor));
		expect(ids).toContain(seeded.homedHere);
		expect(ids).not.toContain(seeded.homedElsewhere);
	});
});
