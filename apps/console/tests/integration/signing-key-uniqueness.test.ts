// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// SIGNING-KEY UNIQUENESS (lib/db/schema/signing.ts), against real Postgres and the real action.
//
// Registration is shape-only — no proof of possession — so an unverified registration claims nothing
// beyond its own org:
//   · two orgs can each register the same public key; neither registration blocks the other;
//   · within one org a key is registered once, and a second registration gets the action's one
//     generic sentence, never the database's error;
//   · across orgs a key_id is unique among VERIFIED keys only (status `active`), and a revoked key
//     (status `invalid`) releases it.
//
// WHAT IS MOCKED: nothing. The action runs under `runWithActor`, as a server action binds an actor.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerOrgSigningKey } from "@/app/server/actions/signing";
import { runWithActor } from "@/lib/authz/actor-context";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { seedAuthz } from "@/lib/authz/seed";
import { getServiceDb } from "@/lib/db";
import { authzActivityLog, grants, member, orgSigningKey, organization, user } from "@/lib/db/schema";
import { describeIfDb, purgeAuthzActivityLog } from "./db";

const ORG_X = randomUUID();
const ORG_Y = randomUUID();
const ADMIN_X = randomUUID();
const ADMIN_Y = randomUUID();
const ORGS = [ORG_X, ORG_Y];
const USERS = [ADMIN_X, ADMIN_Y];

/** A fresh, valid ed25519-shaped public key (32 random bytes, base64) — unique per test. */
function publicKey(): string {
	return Buffer.from(randomUUID().replace(/-/g, "").repeat(2), "hex").toString("base64");
}

/** Registers `key` in `orgId` as its admin. */
function register(userId: string, orgId: string, key: string) {
	return runWithActor({ userId, orgId, credential: "session" }, () =>
		registerOrgSigningKey({ provider: "aws", backend: "kms", key_ref: `arn:aws:kms:eu-west-1:1:key/${orgId}`, public_key: key }),
	);
}

const REFUSAL = "This public key can't be registered for this organization.";

describeIfDb("signing-key uniqueness", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values(USERS.map((id) => ({ id, email: `it-sk-${id}@example.test` })));
		await db.insert(organization).values(ORGS.map((id) => ({ id, name: `it-sk-${id.slice(0, 8)}`, slug: `it-sk-${id.slice(0, 8)}` })));
		await db.insert(member).values([
			{ organizationId: ORG_X, userId: ADMIN_X, role: "admin" },
			{ organizationId: ORG_Y, userId: ADMIN_Y, role: "admin" },
		]);
		await ensureMemberGrant(ORG_X, ADMIN_X, "admin");
		await ensureMemberGrant(ORG_Y, ADMIN_Y, "admin");
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(orgSigningKey).where(inArray(orgSigningKey.org_id, ORGS));
		await purgeAuthzActivityLog(inArray(authzActivityLog.org_id, ORGS));
		await db.delete(grants).where(inArray(grants.org_id, ORGS));
		await db.delete(member).where(inArray(member.organizationId, ORGS));
		await db.delete(organization).where(inArray(organization.id, ORGS));
		await db.delete(user).where(inArray(user.id, USERS));
	});

	it("an unverified registration in one org does not block the same key in another", async () => {
		const key = publicKey();
		const x = await register(ADMIN_X, ORG_X, key);
		const y = await register(ADMIN_Y, ORG_Y, key);
		expect(x.status).toBe("pending_verification");
		expect(y.status).toBe("pending_verification");
		expect(y.keyId).toBe(x.keyId);
	});

	it("a key registered twice in one org gets the one generic refusal", async () => {
		const key = publicKey();
		await register(ADMIN_X, ORG_X, key);
		await expect(register(ADMIN_X, ORG_X, key)).rejects.toThrow(REFUSAL);
	});

	it("the database holds one org's key_id once, whoever writes it", async () => {
		const key = publicKey();
		const { keyId } = await register(ADMIN_X, ORG_X, key);
		const db = getServiceDb();
		await expect(
			db.insert(orgSigningKey).values({
				user_id: ADMIN_X,
				org_id: ORG_X,
				provider: "aws",
				backend: "kms",
				key_ref: "arn:other",
				public_key: key,
				key_id: keyId,
			}),
		).rejects.toMatchObject({ cause: { code: "23505" } });
	});

	it("across orgs a key_id is unique among verified keys, and revoking one releases it", async () => {
		const key = publicKey();
		const x = await register(ADMIN_X, ORG_X, key);
		const y = await register(ADMIN_Y, ORG_Y, key);
		const db = getServiceDb();
		await db.update(orgSigningKey).set({ status: "active" }).where(eq(orgSigningKey.id, x.id));
		await expect(
			db.update(orgSigningKey).set({ status: "active" }).where(eq(orgSigningKey.id, y.id)),
		).rejects.toMatchObject({ cause: { code: "23505" } });

		await db.update(orgSigningKey).set({ status: "invalid" }).where(eq(orgSigningKey.id, x.id));
		await db.update(orgSigningKey).set({ status: "active" }).where(eq(orgSigningKey.id, y.id));
		const [row] = await db.select({ status: orgSigningKey.status }).from(orgSigningKey).where(eq(orgSigningKey.id, y.id));
		expect(row.status).toBe("active");
	});
});
