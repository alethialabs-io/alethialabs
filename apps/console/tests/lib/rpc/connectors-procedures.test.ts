// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connectors board's reader (#6124, ADR 0005 D1) — the body that was the
// `getConnectorsWithStatus` server action, moved into lib/rpc/procedures/connectors.ts. Mocked
// boundaries: a thenable drizzle chain (getServiceDb + withScope), the guard, the PDP and the git
// token refresher. Tenancy (address beats session, a non-member is a 404) is proved for the
// procedure by tests/integration/rpc-tenancy.*; this file pins what the read RETURNS and what it
// does NOT do.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	currentActor: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
	getServiceDb: vi.fn(),
	withScope: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/app/server/actions/identities", () => ({ getValidProviderToken: vi.fn() }));

import { getValidProviderToken } from "@/app/server/actions/identities";
import { getPdp } from "@/lib/authz";
import { authorize, currentActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import type { Connector } from "@/lib/db/schema";
import {
	readConnectorsBoard,
	readConnectorsWithStatus,
} from "@/lib/rpc/procedures/connectors";
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

describe("readConnectorsWithStatus", () => {
	/**
	 * Minimal catalog connector row; spread verbatim into the result. Typed against the real
	 * `Connector` row so a fictional `category` / `auth_method` / `status` is a COMPILE error — the
	 * blank-token-cloud-sheet bug slipped through because these fixtures used made-up auth methods
	 * ("token", "role", "wif") that no real catalog row can hold, so the real api_key routing was
	 * never exercised. (CLAUDE.md bans `Record<string, unknown>` for known shapes for exactly this.)
	 */
	function connector(over: Partial<Connector>): Partial<Connector> {
		return {
			id: "x",
			slug: "x",
			name: "X",
			category: "git",
			auth_method: "oauth",
			status: "active",
			sort_order: 0,
			...over,
		};
	}

	it("marks a git connector connected with a healthy token", async () => {
		// queue order: catalog, account tokens, cloud identities (all), api_key creds
		dbh.setQueue([
			[connector({ slug: "github", category: "git" })],
			[{ provider: "github", expires_at: null, refreshable: false }],
			[],
			[],
		]);
		const [row] = await readConnectorsWithStatus();
		expect(row.connected).toBe(true);
		expect(row.token_health).toBe("healthy");
		expect(row.group).toBe("source");
		expect(row.connection_details).toBeNull();
	});

	it("flags an expired git token (refresh available) as expired", async () => {
		dbh.setQueue([
			[connector({ slug: "github", category: "git" })],
			[
				{
					provider: "github",
					expires_at: new Date(Date.now() - 1000).toISOString(),
					refreshable: true,
				},
			],
			[],
			[],
		]);
		const [row] = await readConnectorsWithStatus();
		expect(row.token_health).toBe("expired");
	});

	it("surfaces a connected cloud account with its details and scope", async () => {
		dbh.setQueue([
			[connector({ slug: "aws", category: "cloud", auth_method: "iam_role" })],
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
		const [row] = await readConnectorsWithStatus();
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
			[connector({ slug: "gcp", category: "cloud", auth_method: "service_account" })],
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
		const [row] = await readConnectorsWithStatus();
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
			[connector({ slug: "azure", category: "cloud", auth_method: "service_principal" })],
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
		const [row] = await readConnectorsWithStatus();
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
			[connector({ slug: "aws", category: "cloud", auth_method: "iam_role" })],
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
		const [row] = await readConnectorsWithStatus();
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
			[connector({ slug: "aws", category: "cloud", auth_method: "iam_role" })],
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
		const [row] = await readConnectorsWithStatus();
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
			[connector({ slug: "digitalocean", category: "cloud", auth_method: "api_key" })],
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
		const [row] = await readConnectorsWithStatus();
		expect(row.connected).toBe(false);
		expect(row.cloud_health).toBeUndefined();
		expect(row.last_error).toBeUndefined();
		expect(row.reverify_identity_id).toBeUndefined();
		expect(row.accounts).toEqual([]);
	});

	it("still surfaces a genuine lost-access (disconnected) token cloud that has credentials", async () => {
		dbh.setQueue([
			[connector({ slug: "hetzner", category: "cloud", auth_method: "api_key" })],
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
		const [row] = await readConnectorsWithStatus();
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
		const [row] = await readConnectorsWithStatus();
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
		const [row] = await readConnectorsWithStatus();
		expect(row.connected).toBe(false);
		expect(row.connection_details).toBeNull();
	});
});

describe("readConnectorsBoard", () => {
	const actor: Actor = { userId: "user-1", orgId: "org-1" };
	const cloudCatalogRow: Partial<Connector> = {
		id: "c-aws",
		slug: "aws",
		name: "AWS",
		category: "cloud",
		auth_method: "iam_role",
		status: "active",
		sort_order: 0,
	};
	const configuredAws = {
		id: "11111111-1111-4111-8111-111111111111",
		name: "AWS Account (123456789012)",
		provider: "aws",
		credentials: {
			role_arn: "arn:aws:iam::123456789012:role/alethia",
			account_id: "123456789012",
			// Fields the board must never echo, even though the row carries them.
			external_id: "EXTERNAL-ID-SECRET",
			token: "ENCRYPTED-TOKEN-ENVELOPE",
		},
		scope: "org",
		status: "connected",
		last_error: null,
		missing_permissions: [],
	};

	beforeEach(() => {
		vi.mocked(getPdp).mockReturnValue({
			can: vi.fn(async () => ({ allowed: true })),
		} as never);
	});

	it("returns the catalog with status, the manage capability and the platform map — and writes nothing", async () => {
		dbh.setQueue([[cloudCatalogRow], [], [configuredAws], []]);
		const board = await readConnectorsBoard(actor);
		expect(board.canManage).toBe(true);
		expect(board.integrations).toHaveLength(1);
		expect(board.integrations[0].connected).toBe(true);
		expect(board.platformConfigured).toHaveProperty("hetzner", true);
		// The page used to create a pending identity per unconnected cloud while rendering. A GET
		// must not: no insert, update or delete is issued by the board read.
		expect(dbh.spies.insert).not.toHaveBeenCalled();
		expect(dbh.spies.update).not.toHaveBeenCalled();
		expect(dbh.spies.delete).not.toHaveBeenCalled();
	});

	it("never puts a stored secret on the wire: only the named public identifiers travel", async () => {
		dbh.setQueue([[cloudCatalogRow], [], [configuredAws], []]);
		const board = await readConnectorsBoard(actor);
		const wire = JSON.stringify(board);
		expect(wire).not.toContain("EXTERNAL-ID-SECRET");
		expect(wire).not.toContain("ENCRYPTED-TOKEN-ENVELOPE");
		expect(board.integrations[0].connection_details).toEqual({
			account_id: "123456789012",
			role_arn: "arn:aws:iam::123456789012:role/alethia",
			project_id: undefined,
			service_account_email: undefined,
			tenant_id: undefined,
			subscription_id: undefined,
			cloud_identity_id: configuredAws.id,
		});
	});

	it("reports canManage=false when the PDP grants neither manage action", async () => {
		vi.mocked(getPdp).mockReturnValue({ can: vi.fn(async () => ({ allowed: false })) } as never);
		dbh.setQueue([[cloudCatalogRow], [], [], []]);
		expect((await readConnectorsBoard(actor)).canManage).toBe(false);
	});

	it("refreshes an expired-but-refreshable git link, then reads the status again", async () => {
		const git: Partial<Connector> = { id: "g", slug: "github", name: "GitHub", category: "git", auth_method: "oauth", status: "active", sort_order: 0 };
		const past = new Date(Date.now() - 60_000).toISOString();
		dbh.setQueue([
			[git],
			[{ provider: "github", expires_at: past, refreshable: true }],
			[],
			[],
			// the second read, after the refresh
			[git],
			[{ provider: "github", expires_at: null, refreshable: true }],
			[],
			[],
		]);
		vi.mocked(getValidProviderToken).mockResolvedValue("t");
		const board = await readConnectorsBoard(actor);
		expect(getValidProviderToken).toHaveBeenCalledWith("github");
		expect(board.integrations[0].token_health).toBe("healthy");
	});

	it("a failed read is an error, never an empty board", async () => {
		dbh.setQueue([new Error("db down")]);
		await expect(readConnectorsBoard(actor)).rejects.toThrow("db down");
	});
});
