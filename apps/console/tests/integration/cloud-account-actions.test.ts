// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6124): the connectors board's id-addressed cloud-account writes against REAL rows.
//
// The PDP is stubbed to ALLOW every call — the worst case, an org-wide grant that names no row —
// so what is measured is the second gate: the identity lookup by id through the scope rule AND the
// addressed org. With the PDP saying yes, an identity the caller cannot reach must still be
// `not-found`, and the connection library (which writes) must never be called for it:
//   · another org's identity, addressed by id;
//   · another member's PERSONAL identity in the caller's own org;
// while the caller's org-shared identity and their own personal one in that org pass through.
// The connection library is the boundary (it would probe a real cloud); its calls are recorded.

import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeIfDb } from "./db";

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/auth", () => ({ auth: { api: {} } }));
vi.mock("@/lib/auth/accounts", () => ({ resolveAccountId: vi.fn() }));
vi.mock("@/lib/connectors/health", () => ({ markHealthy: vi.fn(), markFailed: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	authorizeQuiet: vi.fn(),
	currentActor: vi.fn(),
}));
vi.mock("@/lib/cloud-providers/connections", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/cloud-providers/connections")>();
	const outcome = (identityId: string) => ({
		identityId,
		verified: true,
		status: "connected",
		error: null,
		missingPermissions: [],
	});
	return {
		...actual,
		saveAwsIdentity: vi.fn(async (_s: unknown, id: string) => outcome(id)),
		reverifyConnection: vi.fn(async (_s: unknown, id: string) => outcome(id)),
		renameIdentity: vi.fn(async () => ({ success: true })),
		disconnectIdentity: vi.fn(async () => ({ success: true })),
	};
});

import {
	connectCloudAccount,
	disconnectCloudAccount,
	renameCloudAccount,
	verifyCloudAccount,
} from "@/app/server/actions/identities";
import { authorize } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import * as conn from "@/lib/cloud-providers/connections";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";

const ORG_X = randomUUID();
const ORG_Y = randomUUID();
const CALLER = randomUUID(); // member of X, acting at X
const TEAMMATE = randomUUID(); // another member of X

const seeded = { orgShared: "", ownPersonal: "", teammatePersonal: "", otherOrg: "" };

/** The caller as a signed-in person — the PDP's answer, stubbed to allow. */
const session: Actor = { userId: CALLER, orgId: ORG_X, credential: "session" };

/** Inserts one configured AWS identity. */
async function seedIdentity(userId: string, orgId: string, scope: "org" | "personal"): Promise<string> {
	const [row] = await getServiceDb()
		.insert(cloudIdentities)
		.values({
			user_id: userId,
			org_id: orgId,
			scope,
			provider: "aws",
			name: `it-6124-${scope}`,
			credentials: { role_arn: "arn:aws:iam::123456789012:role/it-6124" },
		})
		.returning({ id: cloudIdentities.id });
	return row.id;
}

/** Every write the board can address by id, against `identityId`. */
function everyWrite(identityId: string) {
	return [
		connectCloudAccount({ method: "aws", identityId, roleArn: "arn:aws:iam::123456789012:role/it-6124" }),
		verifyCloudAccount({ identityId }),
		renameCloudAccount({ identityId, name: "renamed" }),
		disconnectCloudAccount({ identityId }),
	];
}

describeIfDb("cloud-account writes — an id the caller cannot reach is not-found, whatever the PDP said", () => {
	beforeAll(async () => {
		seeded.orgShared = await seedIdentity(TEAMMATE, ORG_X, "org");
		seeded.ownPersonal = await seedIdentity(CALLER, ORG_X, "personal");
		seeded.teammatePersonal = await seedIdentity(TEAMMATE, ORG_X, "personal");
		seeded.otherOrg = await seedIdentity(TEAMMATE, ORG_Y, "org");
	});

	afterAll(async () => {
		await getServiceDb()
			.delete(cloudIdentities)
			.where(inArray(cloudIdentities.id, Object.values(seeded).filter(Boolean)));
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(authorize).mockResolvedValue(session);
	});

	it("another org's identity, addressed by id: every write is not-found and nothing is written", async () => {
		for (const r of await Promise.all(everyWrite(seeded.otherOrg))) {
			expect(!r.ok && r.error.kind).toBe("not-found");
		}
		expect(conn.saveAwsIdentity).not.toHaveBeenCalled();
		expect(conn.reverifyConnection).not.toHaveBeenCalled();
		expect(conn.renameIdentity).not.toHaveBeenCalled();
		expect(conn.disconnectIdentity).not.toHaveBeenCalled();
	});

	it("a teammate's PERSONAL identity in the caller's own org: not-found, nothing written", async () => {
		for (const r of await Promise.all(everyWrite(seeded.teammatePersonal))) {
			expect(!r.ok && r.error.kind).toBe("not-found");
		}
		expect(conn.disconnectIdentity).not.toHaveBeenCalled();
	});

	it("the org's shared identity and the caller's own personal one pass through to the library", async () => {
		for (const id of [seeded.orgShared, seeded.ownPersonal]) {
			for (const r of await Promise.all(everyWrite(id))) expect(r.ok).toBe(true);
		}
		expect(conn.disconnectIdentity).toHaveBeenCalledWith(session, seeded.orgShared, "aws");
	});

	it("a service token pinned to the org gets the org's shared identities only — not its minter's personal one", async () => {
		vi.mocked(authorize).mockResolvedValue({ ...session, credential: "service_token" });
		for (const r of await Promise.all(everyWrite(seeded.ownPersonal))) {
			expect(!r.ok && r.error.kind).toBe("not-found");
		}
		for (const r of await Promise.all(everyWrite(seeded.orgShared))) expect(r.ok).toBe(true);
	});
});
