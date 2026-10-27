// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the connectors actions (the board's reader is
// tests/lib/rpc/connectors-procedures.test.ts): stub the authz guard, a thenable drizzle chain
// (getServiceDb + withScope), the secret-crypto + provider-ping boundaries, and keep the REAL
// generated connector registry. We exercise the real exported actions and assert their guard
// branches, the plain/secret field partition, what gets written, and the returned shapes.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	currentActor: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
	getServiceDb: vi.fn(),
	withScope: vi.fn(),
}));
vi.mock("@/lib/crypto/secrets", () => ({ encryptSecret: vi.fn() }));
vi.mock("@/lib/connectors/verify", () => ({
	verifyConnectorCredential: vi.fn(),
}));

import {
	deleteConnectorCredential,
	saveConnectorCredential,
} from "@/app/server/actions/connectors";
import { authorize, currentActor } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { verifyConnectorCredential as pingConnector } from "@/lib/connectors/verify";
import { encryptSecret } from "@/lib/crypto/secrets";
import { getServiceDb, withScope } from "@/lib/db";

/**
 * A drizzle-ish chain: every builder method returns the chain, and each terminal
 * await (`then`) shifts the next seeded result off `queue` (FIFO, matching the
 * action's deterministic query order). An Error in the queue is thrown on await.
 */
function makeDb() {
	const spies = {
		where: vi.fn(),
		update: vi.fn(),
		insert: vi.fn(),
		delete: vi.fn(),
		values: vi.fn(),
		onConflictDoUpdate: vi.fn(),
		set: vi.fn(),
	};
	let queue: unknown[] = [];
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		innerJoin: () => db,
		leftJoin: () => db,
		orderBy: () => db,
		limit: () => db,
		returning: () => db,
		where: (...a: unknown[]) => {
			spies.where(...a);
			return db;
		},
		update: (...a: unknown[]) => {
			spies.update(...a);
			return db;
		},
		insert: (...a: unknown[]) => {
			spies.insert(...a);
			return db;
		},
		delete: (...a: unknown[]) => {
			spies.delete(...a);
			return db;
		},
		values: (...a: unknown[]) => {
			spies.values(...a);
			return db;
		},
		onConflictDoUpdate: (...a: unknown[]) => {
			spies.onConflictDoUpdate(...a);
			return db;
		},
		set: (...a: unknown[]) => {
			spies.set(...a);
			return db;
		},
		then: (resolve: (v: unknown) => void) => {
			const next = queue.length ? queue.shift() : [];
			if (next instanceof Error) throw next;
			return resolve(next);
		},
	});
	return {
		db,
		spies,
		setQueue: (q: unknown[]) => {
			queue = q;
		},
	};
}

let dbh: ReturnType<typeof makeDb>;

beforeEach(() => {
	vi.clearAllMocks();
	dbh = makeDb();
	vi.mocked(getServiceDb).mockReturnValue(dbh.db as never);
	// withScope just runs the callback against our chain and returns its (thenable) result.
	vi.mocked(withScope).mockImplementation(((_s: unknown, fn: (tx: unknown) => unknown) =>
		fn(dbh.db)) as never);
	vi.mocked(authorize).mockResolvedValue({
		userId: "user-1",
		orgId: "org-1",
	} as never);
	vi.mocked(currentActor).mockResolvedValue({
		userId: "user-1",
		orgId: "org-1",
	} as never);
});

describe("saveConnectorCredential", () => {
	const save = (slug: string, fields: Record<string, string>) => saveConnectorCredential({ slug, fields });

	it("is a typed forbidden refusal when the caller lacks manage_connectors", async () => {
		vi.mocked(authorize).mockRejectedValue(new ForbiddenError("manage_connectors", { type: "connector" }));
		const r = await save("vault", { address: "a", token: "t" });
		expect(r).toEqual({ ok: false, error: { kind: "forbidden", message: expect.any(String) } });
		expect(pingConnector).not.toHaveBeenCalled();
	});

	it("refuses an unknown connector slug as a validation error on the slug", async () => {
		const r = await save("does-not-exist", {});
		expect(r).toEqual({
			ok: false,
			error: {
				kind: "validation",
				message: "Unknown connector: does-not-exist",
				fields: { slug: ["Unknown connector: does-not-exist"] },
			},
		});
		expect(authorize).not.toHaveBeenCalled();
	});

	it("reports a missing required field UNDER that field, before touching the DB or the provider", async () => {
		// vault requires `address` (plain) + `token` (secret); omit the token.
		const r = await save("vault", { address: "https://v" });
		expect(r).toEqual({
			ok: false,
			error: {
				kind: "validation",
				message: "Vault Token is required.",
				fields: { "fields.token": ["Vault Token is required."] },
			},
		});
		expect(pingConnector).not.toHaveBeenCalled();
		expect(getServiceDb).not.toHaveBeenCalled();
	});

	it("is a not-found refusal when the connector is missing from the catalog", async () => {
		dbh.setQueue([[]]); // catalog lookup → no row
		const r = await save("vault", { address: "https://v", token: "s3cret" });
		expect(r).toEqual({ ok: false, error: { kind: "not-found", message: "Connector not in catalog: vault" } });
		expect(dbh.spies.values).not.toHaveBeenCalled();
	});

	it("partitions plain/secret fields, encrypts secrets, pings, and upserts a verified org credential", async () => {
		vi.mocked(pingConnector).mockResolvedValue({ ok: true, message: "pong" } as never);
		vi.mocked(encryptSecret).mockReturnValue("ENC" as never);
		dbh.setQueue([[{ id: "conn-1" }], []]); // catalog row, then insert result

		const fields = { address: "https://v", token: "s3cret" };
		const r = await save("vault", fields);

		expect(r).toEqual({ ok: true, data: { verified: true, message: "pong" } });
		// Ping receives the FULL (unencrypted) field set.
		expect(pingConnector).toHaveBeenCalledWith("vault", fields);
		// Only the secret field is encrypted; the plain field is not.
		expect(encryptSecret).toHaveBeenCalledWith({ token: "s3cret" });
		// The written row stores plain fields in clear, the encrypted blob, scope=org, verified.
		const values = dbh.spies.values.mock.calls[0][0] as {
			scope: string;
			is_verified: boolean;
			org_id: string;
			credentials: { fields: Record<string, string>; secret: unknown };
		};
		expect(values.scope).toBe("org");
		expect(values.org_id).toBe("org-1");
		expect(values.is_verified).toBe(true);
		expect(values.credentials.fields).toEqual({ address: "https://v" });
		expect(values.credentials.secret).toBe("ENC");
		expect(dbh.spies.onConflictDoUpdate).toHaveBeenCalled();
	});

	it("still saves (verified=false) when the provider ping fails — a success the form shows as unverified", async () => {
		vi.mocked(pingConnector).mockResolvedValue({ ok: false } as never);
		vi.mocked(encryptSecret).mockReturnValue("ENC" as never);
		dbh.setQueue([[{ id: "conn-1" }], []]);

		const r = await save("vault", { address: "https://v", token: "s3cret" });
		expect(r).toEqual({ ok: true, data: { verified: false, message: undefined } });
		const values = dbh.spies.values.mock.calls[0][0] as { is_verified: boolean };
		expect(values.is_verified).toBe(false);
	});

	it("an encryption failure is `unexpected` with a reference — its message never reaches the browser", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(pingConnector).mockResolvedValue({ ok: true } as never);
		vi.mocked(encryptSecret).mockImplementation(() => {
			throw new Error("no key configured");
		});
		dbh.setQueue([[{ id: "conn-1" }]]);
		const r = await save("vault", { address: "https://v", token: "s3cret" });
		expect(r).toEqual({ ok: false, error: { kind: "unexpected", ref: expect.any(String) } });
		expect(JSON.stringify(r)).not.toContain("no key configured");
		expect(dbh.spies.values).not.toHaveBeenCalled();
	});
});

describe("deleteConnectorCredential", () => {
	it("is a typed forbidden refusal when unauthorized", async () => {
		vi.mocked(authorize).mockRejectedValue(new ForbiddenError("manage_connectors", { type: "connector" }));
		const r = await deleteConnectorCredential({ slug: "vault" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.error.kind).toBe("forbidden");
		expect(dbh.spies.delete).not.toHaveBeenCalled();
	});

	it("is a not-found refusal when the connector is not in the catalog", async () => {
		dbh.setQueue([[]]);
		const r = await deleteConnectorCredential({ slug: "vault" });
		expect(r).toEqual({ ok: false, error: { kind: "not-found", message: "Connector not in catalog: vault" } });
		expect(dbh.spies.delete).not.toHaveBeenCalled();
	});

	it("deletes the credential within an org scope", async () => {
		dbh.setQueue([[{ id: "conn-1" }], []]);
		const r = await deleteConnectorCredential({ slug: "vault" });
		expect(r).toEqual({ ok: true, data: { slug: "vault" } });
		expect(dbh.spies.delete).toHaveBeenCalledTimes(1);
		expect(withScope).toHaveBeenCalledWith(
			{ ownerId: "user-1", orgId: "org-1" },
			expect.any(Function),
		);
	});
});
