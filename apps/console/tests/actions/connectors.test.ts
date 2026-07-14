// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the connectors actions: stub the authz guard, a thenable drizzle chain
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
	getConnectorsWithStatus,
	saveConnectorCredential,
	setCloudIdentityScope,
	setConnectorCredentialScope,
} from "@/app/server/actions/connectors";
import { authorize, currentActor } from "@/lib/authz/guard";
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
	it("rejects when the caller lacks manage_connectors", async () => {
		vi.mocked(authorize).mockRejectedValue(new Error("Forbidden"));
		await expect(
			saveConnectorCredential("vault", { address: "a", token: "t" }),
		).rejects.toThrow(/Forbidden/);
	});

	it("returns an error for an unknown connector slug", async () => {
		const r = await saveConnectorCredential("does-not-exist", {});
		expect(r).toEqual({ ok: false, error: "Unknown connector: does-not-exist" });
	});

	it("validates required fields before touching the DB", async () => {
		// vault requires `address` (plain) + `token` (secret); omit the token.
		const r = await saveConnectorCredential("vault", { address: "https://v" });
		expect(r).toEqual({ ok: false, error: "Vault Token is required." });
		expect(pingConnector).not.toHaveBeenCalled();
	});

	it("returns an error when the connector is missing from the catalog", async () => {
		dbh.setQueue([[]]); // catalog lookup → no row
		const r = await saveConnectorCredential("vault", {
			address: "https://v",
			token: "s3cret",
		});
		expect(r).toEqual({ ok: false, error: "Connector not in catalog: vault" });
	});

	it("partitions plain/secret fields, encrypts secrets, pings, and upserts a verified org credential", async () => {
		vi.mocked(pingConnector).mockResolvedValue({ ok: true, message: "pong" } as never);
		vi.mocked(encryptSecret).mockReturnValue("ENC" as never);
		dbh.setQueue([[{ id: "conn-1" }], []]); // catalog row, then insert result

		const fields = { address: "https://v", token: "s3cret" };
		const r = await saveConnectorCredential("vault", fields);

		expect(r).toEqual({ ok: true, verified: true, message: "pong" });
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

	it("still saves (verified=false) when the provider ping fails", async () => {
		vi.mocked(pingConnector).mockResolvedValue({ ok: false } as never);
		vi.mocked(encryptSecret).mockReturnValue("ENC" as never);
		dbh.setQueue([[{ id: "conn-1" }], []]);

		const r = await saveConnectorCredential("vault", {
			address: "https://v",
			token: "s3cret",
		});
		expect(r).toEqual({ ok: true, verified: false, message: undefined });
		const values = dbh.spies.values.mock.calls[0][0] as { is_verified: boolean };
		expect(values.is_verified).toBe(false);
	});

	it("returns an error when encryption throws", async () => {
		vi.mocked(pingConnector).mockResolvedValue({ ok: true } as never);
		vi.mocked(encryptSecret).mockImplementation(() => {
			throw new Error("no key configured");
		});
		dbh.setQueue([[{ id: "conn-1" }]]);
		const r = await saveConnectorCredential("vault", {
			address: "https://v",
			token: "s3cret",
		});
		expect(r).toEqual({ ok: false, error: "no key configured" });
		expect(dbh.spies.values).not.toHaveBeenCalled();
	});
});

describe("deleteConnectorCredential", () => {
	it("rejects when unauthorized", async () => {
		vi.mocked(authorize).mockRejectedValue(new Error("Forbidden"));
		await expect(deleteConnectorCredential("vault")).rejects.toThrow(/Forbidden/);
	});

	it("returns an error when the connector is not in the catalog", async () => {
		dbh.setQueue([[]]);
		const r = await deleteConnectorCredential("vault");
		expect(r).toEqual({ ok: false, error: "Connector not in catalog: vault" });
		expect(dbh.spies.delete).not.toHaveBeenCalled();
	});

	it("deletes the credential within an org scope", async () => {
		dbh.setQueue([[{ id: "conn-1" }], []]);
		const r = await deleteConnectorCredential("vault");
		expect(r).toEqual({ ok: true });
		expect(dbh.spies.delete).toHaveBeenCalledTimes(1);
		expect(withScope).toHaveBeenCalledWith(
			{ ownerId: "user-1", orgId: "org-1" },
			expect.any(Function),
		);
	});
});

describe("setConnectorCredentialScope", () => {
	it("returns an error when the connector is not in the catalog", async () => {
		dbh.setQueue([[]]);
		const r = await setConnectorCredentialScope("vault", "org");
		expect(r).toEqual({ ok: false, error: "Connector not in catalog: vault" });
	});

	it("promotes the caller's personal credential to org scope", async () => {
		dbh.setQueue([[{ id: "conn-1" }], [{ id: "cred-1" }]]);
		const r = await setConnectorCredentialScope("vault", "org");
		expect(r).toEqual({ ok: true });
		const setArg = dbh.spies.set.mock.calls[0][0] as {
			scope: string;
			org_id: string;
		};
		expect(setArg.scope).toBe("org");
		expect(setArg.org_id).toBe("org-1");
	});

	it("reports when there is no personal credential to share", async () => {
		dbh.setQueue([[{ id: "conn-1" }], []]); // update returns no rows
		const r = await setConnectorCredentialScope("vault", "org");
		expect(r).toEqual({ ok: false, error: "No personal credential to share." });
	});

	it("demotes an org credential back to personal", async () => {
		dbh.setQueue([[{ id: "conn-1" }], [{ id: "cred-1" }]]);
		const r = await setConnectorCredentialScope("vault", "personal");
		expect(r).toEqual({ ok: true });
		const setArg = dbh.spies.set.mock.calls[0][0] as { scope: string };
		expect(setArg.scope).toBe("personal");
	});

	it("reports when there is no shared credential to make personal", async () => {
		dbh.setQueue([[{ id: "conn-1" }], []]);
		const r = await setConnectorCredentialScope("vault", "personal");
		expect(r).toEqual({
			ok: false,
			error: "No shared credential to make personal.",
		});
	});

	it("maps a unique-violation into a friendly conflict error", async () => {
		dbh.setQueue([[{ id: "conn-1" }], new Error("duplicate key")]);
		const r = await setConnectorCredentialScope("vault", "org");
		expect(r).toEqual({
			ok: false,
			error: "An org credential already exists for this connector.",
		});
	});
});

describe("setCloudIdentityScope", () => {
	it("rejects when manage_identities is denied", async () => {
		vi.mocked(authorize).mockRejectedValue(new Error("Forbidden"));
		await expect(setCloudIdentityScope("ci-1", "org")).rejects.toThrow(
			/Forbidden/,
		);
	});

	it("promotes a personal cloud identity to org scope", async () => {
		dbh.setQueue([[{ id: "ci-1" }]]); // update returning
		const r = await setCloudIdentityScope("ci-1", "org");
		expect(r).toEqual({ ok: true });
		const setArg = dbh.spies.set.mock.calls[0][0] as {
			scope: string;
			org_id: string;
		};
		expect(setArg.scope).toBe("org");
		expect(setArg.org_id).toBe("org-1");
	});

	it("returns not-found when no row matched", async () => {
		dbh.setQueue([[]]);
		const r = await setCloudIdentityScope("ci-1", "personal");
		expect(r).toEqual({
			ok: false,
			error: "Cloud identity not found for this action.",
		});
	});

	it("maps a DB error to a generic scope-change failure", async () => {
		dbh.setQueue([new Error("constraint")]);
		const r = await setCloudIdentityScope("ci-1", "org");
		expect(r).toEqual({
			ok: false,
			error: "Could not change the credential's scope.",
		});
	});
});

describe("getConnectorsWithStatus", () => {
	/** Minimal catalog connector row; spread verbatim into the result. */
	function connector(over: Record<string, unknown>) {
		return {
			id: "x",
			slug: "x",
			name: "X",
			category: "git",
			auth_method: "oauth2",
			status: "active",
			sort_order: 0,
			...over,
		};
	}

	it("marks a git connector connected with a healthy token", async () => {
		// queue order: catalog, account tokens, cloud identities (all), api_key creds
		dbh.setQueue([
			[connector({ slug: "github", category: "git" })],
			[{ provider: "github", expires_at: null, refresh_token: null }],
			[],
			[],
		]);
		const [row] = await getConnectorsWithStatus();
		expect(row.connected).toBe(true);
		expect(row.token_health).toBe("healthy");
		expect(row.group).toBe("apps");
		expect(row.connection_details).toBeNull();
	});

	it("flags an expired git token (refresh available) as expired", async () => {
		dbh.setQueue([
			[connector({ slug: "github", category: "git" })],
			[
				{
					provider: "github",
					expires_at: new Date(Date.now() - 1000).toISOString(),
					refresh_token: "r",
				},
			],
			[],
			[],
		]);
		const [row] = await getConnectorsWithStatus();
		expect(row.token_health).toBe("expired");
	});

	it("surfaces a connected cloud account with its details and scope", async () => {
		dbh.setQueue([
			[connector({ slug: "aws", category: "cloud", auth_method: "role" })],
			[],
			[
				{
					id: "ci-1",
					name: "prod",
					provider: "aws",
					credentials: { account_id: "123456789012", role_arn: "arn:x" },
					scope: "org",
					status: "connected",
					last_error: null,
					missing_permissions: [],
				},
			],
			[],
		]);
		const [row] = await getConnectorsWithStatus();
		expect(row.connected).toBe(true);
		expect(row.group).toBe("clouds");
		expect(row.scope).toBe("org");
		expect(row.cloud_health).toBeUndefined();
		expect(row.accounts).toHaveLength(1);
		expect(row.accounts?.[0]).toMatchObject({
			identityId: "ci-1",
			name: "prod",
			label: "123456789012",
			status: "connected",
		});
		expect(row.connection_details).toMatchObject({
			account_id: "123456789012",
			role_arn: "arn:x",
			cloud_identity_id: "ci-1",
		});
	});

	it("drives the re-verify treatment for a failed cloud verification", async () => {
		dbh.setQueue([
			[connector({ slug: "gcp", category: "cloud", auth_method: "wif" })],
			[],
			[
				{
					id: "h-1",
					name: "GCP",
					provider: "gcp",
					status: "failed",
					last_error: "boom",
					// A genuinely-configured identity (has creds) whose verification failed.
					credentials: { project_id: "p-1" },
					scope: "org",
					missing_permissions: [],
				},
			],
			[],
		]);
		const [row] = await getConnectorsWithStatus();
		expect(row.connected).toBe(false);
		expect(row.cloud_health).toBe("failed");
		expect(row.last_error).toBe("boom");
		expect(row.reverify_identity_id).toBe("h-1");
	});

	// The reported bug: a cloud whose verification failed was filtered out of `accounts` entirely,
	// which left it with NO disconnect affordance anywhere in the UI — the connection was unremovable.
	// It must be listed, carrying its failure, so it can be re-verified or removed.
	it("lists a FAILED cloud account so it can still be removed", async () => {
		dbh.setQueue([
			[connector({ slug: "azure", category: "cloud", auth_method: "oidc" })],
			[],
			[
				{
					id: "az-1",
					name: "Azure",
					provider: "azure",
					status: "disconnected",
					last_error: "AADSTS700016: Application with identifier '…' was not found",
					credentials: { subscription_id: "s-1", tenant_id: "t-1" },
					scope: "org",
					missing_permissions: [],
				},
			],
			[],
		]);
		const [row] = await getConnectorsWithStatus();
		expect(row.connected).toBe(false);
		expect(row.accounts).toHaveLength(1);
		expect(row.accounts?.[0]).toMatchObject({
			identityId: "az-1",
			status: "failed",
		});
		expect(row.accounts?.[0].lastError).toMatch(/AADSTS700016/);
	});

	// `degraded` is authenticated-but-under-permissioned. It is NOT disconnected, so the connector
	// still reads as connected — but it must say so rather than reporting an unqualified green.
	it("surfaces a DEGRADED account as connected, with its missing permissions", async () => {
		dbh.setQueue([
			[connector({ slug: "aws", category: "cloud", auth_method: "role" })],
			[],
			[
				{
					id: "ci-d",
					name: "prod",
					provider: "aws",
					status: "degraded",
					last_error: null,
					credentials: { account_id: "1", role_arn: "arn:x" },
					scope: "org",
					missing_permissions: ["ec2:DescribeVpcs"],
				},
			],
			[],
		]);
		const [row] = await getConnectorsWithStatus();
		expect(row.connected).toBe(true);
		expect(row.cloud_health).toBe("degraded");
		expect(row.missing_permissions).toEqual(["ec2:DescribeVpcs"]);
		expect(row.reverify_identity_id).toBe("ci-d");
		expect(row.accounts?.[0]).toMatchObject({ status: "degraded" });
	});

	// One healthy + one broken account used to render as a flat "Connected", hiding the broken one
	// entirely — it was invisible and un-removable from the board.
	it("keeps a connector connected when one of two accounts is broken, but still lists the broken one", async () => {
		dbh.setQueue([
			[connector({ slug: "aws", category: "cloud", auth_method: "role" })],
			[],
			[
				{
					id: "ok-1",
					name: "prod",
					provider: "aws",
					status: "connected",
					last_error: null,
					credentials: { account_id: "1", role_arn: "arn:a" },
					scope: "org",
					missing_permissions: [],
				},
				{
					id: "bad-1",
					name: "staging",
					provider: "aws",
					status: "disconnected",
					last_error: "role gone",
					credentials: { account_id: "2", role_arn: "arn:b" },
					scope: "org",
					missing_permissions: [],
				},
			],
			[],
		]);
		const [row] = await getConnectorsWithStatus();
		expect(row.connected).toBe(true);
		expect(row.accounts).toHaveLength(2);
		expect(row.accounts?.map((a) => a.status)).toEqual(["connected", "failed"]);
		// The healthy account is the primary — connection_details must not describe the broken one.
		expect(row.connection_details?.cloud_identity_id).toBe("ok-1");
	});

	it("ignores never-configured placeholder identities (no phantom 'Verification failed')", async () => {
		// A `disconnected` unverified row with EMPTY credentials — the sweeper poisoning an eager
		// connect-sheet placeholder. It must NOT surface as a failed verification.
		dbh.setQueue([
			[connector({ slug: "digitalocean", category: "cloud", auth_method: "token" })],
			[],
			[
				{
					id: "ph-1",
					name: "DO",
					provider: "digitalocean",
					status: "disconnected",
					last_error: "No API token is stored for this connection.",
					credentials: {},
					scope: "org",
					missing_permissions: [],
				},
			],
			[],
		]);
		const [row] = await getConnectorsWithStatus();
		expect(row.connected).toBe(false);
		expect(row.cloud_health).toBeUndefined();
		expect(row.last_error).toBeUndefined();
		expect(row.reverify_identity_id).toBeUndefined();
		expect(row.accounts).toEqual([]);
	});

	it("still surfaces a genuine lost-access (disconnected) token cloud that has credentials", async () => {
		dbh.setQueue([
			[connector({ slug: "hetzner", category: "cloud", auth_method: "token" })],
			[],
			[
				{
					id: "d-1",
					name: "Hetzner",
					provider: "hetzner",
					status: "disconnected",
					last_error: "Token rejected by hetzner (HTTP 401).",
					credentials: { token: "enc:…" },
					scope: "org",
					missing_permissions: [],
				},
			],
			[],
		]);
		const [row] = await getConnectorsWithStatus();
		expect(row.cloud_health).toBe("failed");
		expect(row.reverify_identity_id).toBe("d-1");
	});

	it("marks an api_key connector connected from a verified stored credential", async () => {
		dbh.setQueue([
			[connector({ slug: "vault", category: "secrets", auth_method: "api_key" })],
			[],
			[],
			[{ slug: "vault", is_verified: true, scope: "org" }],
		]);
		const [row] = await getConnectorsWithStatus();
		expect(row.connected).toBe(true);
		expect(row.group).toBe("secrets");
		expect(row.scope).toBe("org");
		expect(row.token_health).toBe("healthy");
	});

	it("falls back to a logged-out catalog (everything disconnected) when no actor", async () => {
		vi.mocked(currentActor).mockRejectedValue(new Error("no session"));
		// Only the public catalog query runs when scope is null.
		dbh.setQueue([
			[connector({ slug: "github", category: "git" })],
		]);
		const [row] = await getConnectorsWithStatus();
		expect(row.connected).toBe(false);
		expect(row.connection_details).toBeNull();
	});
});
