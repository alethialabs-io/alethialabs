// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// GET /api/cli/clusters/:id/kubeconfig/:mintId (#5281) — the poll, with the route AND
// lib/kubeconfig-mint/poll.ts real and only the transaction faked.
//
// The fake transaction holds ONE mint row and models the two statements whose ORDER this file is
// about: the head SELECT, and the `DELETE … RETURNING sealed_result` that both reads and removes the
// ciphertext. It does not evaluate WHERE clauses — whether the query is scoped to the right org,
// actor and cluster is a property of SQL against a real database, and
// tests/integration/kubeconfig-mint-routes.test.ts drives it there (a teammate's poll, another
// cluster's id, the real read-once DELETE). What this file pins is the control flow: authority is
// re-checked BEFORE anything is consumed, `ready` is served once, an expired `ready` is never
// served, and the delivery audit row is written in the same transaction and carries no ciphertext.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BuiltInRole, BUILT_IN_ROLES } from "@/lib/authz/registry";
import { ForbiddenError } from "@/lib/authz/types";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const CLUSTER = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const MINT = "77777777-7777-4777-8777-777777777777";
const JOB = "88888888-8888-4888-8888-888888888888";
/** A plausible sealed blob: 66+ base64url chars. */
const SEALED = `${"A".repeat(40)}sealedCiphertextOnly${"b".repeat(30)}`;
const EXPIRES = new Date("2026-10-01T12:10:00.000Z");

type Status = "pending" | "ready" | "failed" | "expired";
interface FakeRow {
	status: Status;
	tier: "readonly" | "admin";
	sealed_result: string | null;
	failure_reason: string | null;
	private_endpoint: boolean | null;
	expired_now: boolean;
	job_status: string | null;
}

/** The one row the fake transaction holds; null once it has been deleted. */
let row: FakeRow | null = null;
/** Every audit_log insert the fake transaction saw, in order. */
const audits: unknown[] = [];
/** Every statement the fake transaction ran, in order — so a test can read the sequence. */
const statements: string[] = [];
/** Make the audit insert throw, to drive the failure branch. */
let auditThrows = false;

/** A drizzle-shaped chain whose every method returns itself, ending in `limit`. */
function selectChain() {
	const chain = {
		from: () => chain,
		innerJoin: () => chain,
		leftJoin: () => chain,
		where: () => chain,
		limit: async () => {
			statements.push("select");
			return row
				? [
						{
							status: row.status,
							tier: row.tier,
							shape: "exec",
							ttl_seconds: 3600,
							job_id: JOB,
							failure_reason: row.failure_reason,
							private_endpoint: row.private_endpoint,
							expires_at: EXPIRES,
							expired_now: row.expired_now,
							project_id: PROJECT,
							job_status: row.job_status,
						},
					]
				: [];
		},
	};
	return chain;
}

const fakeTx = {
	select: () => selectChain(),
	delete: () => ({
		where: () => ({
			returning: async () => {
				statements.push("delete");
				// The SQL's own predicate: status = 'ready' AND expires_at > now().
				if (!row || row.status !== "ready" || row.expired_now) return [];
				const taken = { sealed_result: row.sealed_result, private_endpoint: row.private_endpoint };
				row = null;
				return [taken];
			},
		}),
	}),
	insert: () => ({
		values: async (v: unknown) => {
			statements.push("audit");
			if (auditThrows) throw new Error(`insert failed near ${SEALED}`);
			audits.push(v);
		},
	}),
};

vi.mock("@/lib/db", () => ({
	withActorScope: async (_actor: unknown, fn: (tx: typeof fakeTx) => Promise<unknown>) => {
		statements.push("begin");
		return fn(fakeTx);
	},
}));
vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
const enforce = vi.fn();
const can = vi.fn();
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ enforce, can }) }));
vi.mock("@/lib/auth/trusted-ip", () => ({ trustedClientIp: vi.fn(() => "198.51.100.4") }));

const logged: unknown[] = [];
vi.mock("@/lib/observability/log", () => {
	const logger = {
		info: (...a: unknown[]) => logged.push(a),
		warn: (...a: unknown[]) => logged.push(a),
		error: (...a: unknown[]) => logged.push(a),
		debug: (...a: unknown[]) => logged.push(a),
		child: () => logger,
	};
	return { log: logger };
});

import { GET } from "@/app/api/cli/clusters/[id]/kubeconfig/[mintId]/route";
import { authorizeCli } from "@/lib/authz/guard";

let role: BuiltInRole = "operator";

/** Whether the built-in role `r` holds `cluster:<action>` in the real registry. */
function roleHolds(r: BuiltInRole, action: string): boolean {
	const keys = BUILT_IN_ROLES[r];
	return keys === "*" || keys.some((k) => k === `cluster:${action}`);
}

/** A mint row in `status`, with `over` applied. */
function mint(status: Status, over: Partial<FakeRow> = {}): FakeRow {
	return {
		status,
		tier: "readonly",
		sealed_result: status === "ready" ? SEALED : null,
		failure_reason: status === "failed" ? "The cluster was not found in the cloud account." : null,
		private_endpoint: status === "ready" ? true : null,
		expired_now: false,
		job_status: status === "pending" ? "QUEUED" : "SUCCESS",
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	row = null;
	audits.length = 0;
	statements.length = 0;
	logged.length = 0;
	auditThrows = false;
	role = "operator";
	vi.mocked(authorizeCli).mockImplementation(async (_req, action) =>
		roleHolds(role, action)
			? { actor: { userId: USER, orgId: ORG }, credential: "session", orgScope: [ORG, USER] }
			: { error: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) },
	);
	enforce.mockImplementation(async (_actor: unknown, action: "access_admin" | "access_readonly") => {
		if (!roleHolds(role, action)) throw new ForbiddenError(action, { type: "cluster" });
	});
	can.mockImplementation(async (_actor: unknown, action: "access_admin" | "access_readonly") => ({
		allowed: roleHolds(role, action),
	}));
});

/** Polls `mintId` on `clusterId`. */
async function poll(mintId = MINT, clusterId = CLUSTER): Promise<Response> {
	return GET(
		new Request(`https://console.local/api/cli/clusters/${clusterId}/kubeconfig/${mintId}`),
		{ params: Promise.resolve({ id: clusterId, mintId }) },
	);
}

describe("read once", () => {
	it("serves a ready mint's ciphertext, then 404s the next poll", async () => {
		row = mint("ready");
		const first = await poll();
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ status: "ready", private_endpoint: true, sealed: SEALED });

		const second = await poll();
		expect(second.status).toBe(404);
		expect(await second.text()).not.toContain(SEALED);
	});

	it("two concurrent polls: exactly one gets the ciphertext", async () => {
		row = mint("ready");
		const [a, b] = await Promise.all([poll(), poll()]);
		const bodies = [await a.text(), await b.text()];
		expect(bodies.filter((t) => t.includes(SEALED))).toHaveLength(1);
		expect([a.status, b.status].sort()).toEqual([200, 404]);
	});

	it("writes the delivery audit row in the same transaction, after the consuming DELETE, with no ciphertext", async () => {
		row = mint("ready");
		await poll();
		expect(statements).toEqual(["begin", "select", "delete", "audit"]);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({
			project_id: PROJECT,
			user_id: USER,
			action: "STATUS_CHANGED",
			component_type: "kubeconfig_mint",
			component_id: MINT,
			changes: {
				event: "kubeconfig_mint.delivered",
				mint_id: MINT,
				cluster_id: CLUSTER,
				tier: "readonly",
				client: "cli",
				source_ip: "198.51.100.4",
			},
		});
		expect(JSON.stringify(audits)).not.toContain(SEALED);
	});

	it("never serves a ready row past its window, and does not consume it", async () => {
		row = mint("ready", { expired_now: true });
		const res = await poll();
		expect(await res.json()).toEqual({ status: "expired", private_endpoint: true });
		expect(statements).not.toContain("delete");
		expect(audits).toHaveLength(0);
	});

	it("an audit failure is a 500 that neither returns nor logs the ciphertext", async () => {
		row = mint("ready");
		auditThrows = true;
		const res = await poll();
		expect(res.status).toBe(500);
		expect(await res.text()).not.toContain(SEALED);
		expect(logged.length).toBeGreaterThan(0);
		expect(JSON.stringify(logged)).not.toContain(SEALED);
	});
});

describe("who may collect", () => {
	it("a viewer is refused before anything is read", async () => {
		role = "viewer";
		row = mint("ready");
		const res = await poll();
		expect(res.status).toBe(403);
		expect(statements).toEqual([]);
	});

	it("an operator cannot collect an ADMIN mint, and the refusal consumes nothing", async () => {
		row = mint("ready", { tier: "admin" });
		const res = await poll();
		expect(res.status).toBe(403);
		expect(enforce).toHaveBeenCalledWith(
			{ userId: USER, orgId: ORG },
			"access_admin",
			{ type: "cluster", id: CLUSTER },
		);
		expect(statements).not.toContain("delete");
		expect(row).not.toBeNull();
	});

	it("an admin collects an ADMIN mint", async () => {
		role = "admin";
		row = mint("ready", { tier: "admin" });
		const res = await poll();
		expect(res.status).toBe(200);
	});

	it("does not re-ask the PDP for a read-only mint (authorizeCli already checked access_readonly)", async () => {
		row = mint("pending");
		await poll();
		expect(vi.mocked(authorizeCli).mock.calls.map((c) => c[1])).toEqual(["access_readonly"]);
		expect(enforce).not.toHaveBeenCalled();
		expect(can).not.toHaveBeenCalled();
	});

	it("an operator polling a PENDING admin mint is refused by the non-recording probe, not enforce (#5667)", async () => {
		row = mint("pending", { tier: "admin" });
		const res = await poll();
		expect(res.status).toBe(403);
		expect(can).toHaveBeenCalledWith({ userId: USER, orgId: ORG }, "access_admin", { type: "cluster", id: CLUSTER });
		expect(enforce).not.toHaveBeenCalled();
	});

	it("a mint that is not there — someone else's, another cluster's, swept — is a 404", async () => {
		row = null;
		expect((await poll()).status).toBe(404);
	});

	it("a malformed mint id is a 404 without a query", async () => {
		expect((await poll("nope")).status).toBe(404);
		expect(statements).toEqual([]);
	});
});

describe("the other states", () => {
	it("pending carries the window's end", async () => {
		row = mint("pending");
		expect(await (await poll()).json()).toEqual({
			status: "pending",
			private_endpoint: null,
			expires_at: EXPIRES.toISOString(),
		});
	});

	it.each(["FAILED", "CANCELLED", "SUCCESS"])(
		"a pending mint whose job is already %s answers failed at once, with the generic reason",
		async (job_status) => {
			row = mint("pending", { job_status });
			expect(await (await poll()).json()).toEqual({
				status: "failed",
				private_endpoint: null,
				reason: "The runner could not mint the credential.",
			});
		},
	);

	it.each(["QUEUED", "CLAIMED", "PROCESSING"])("a pending mint whose job is %s stays pending", async (job_status) => {
		row = mint("pending", { job_status });
		expect((await (await poll()).json()).status).toBe("pending");
	});

	it("failed carries the stored reason", async () => {
		row = mint("failed");
		expect(await (await poll()).json()).toEqual({
			status: "failed",
			private_endpoint: null,
			reason: "The cluster was not found in the cloud account.",
		});
	});

	it("expired is expired", async () => {
		row = mint("expired");
		expect(await (await poll()).json()).toEqual({ status: "expired", private_endpoint: null });
	});

	it("marks EVERY response no-store", async () => {
		const responses: Response[] = [];
		for (const s of ["pending", "ready", "failed", "expired"] as const) {
			row = mint(s);
			responses.push(await poll());
		}
		row = null;
		responses.push(await poll());
		role = "viewer";
		responses.push(await poll());
		expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 404, 403]);
		for (const r of responses) expect(r.headers.get("Cache-Control")).toBe("no-store");
	});
});
