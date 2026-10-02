// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/clusters/:id/kubeconfig (#5281) — the route's own decisions, with the queueing
// logic (lib/kubeconfig-mint/request.ts) stubbed. What the database does with a queued mint — the org
// filter, the one transaction, the audit row's columns — is tests/integration/kubeconfig-mint-routes
// .test.ts's, against real Postgres.
//
// The guard is stubbed BY ROLE, against the REAL built-in role table (lib/authz/registry.ts): a call
// is allowed exactly when the actor's role holds `cluster:<action>` there. So "an operator cannot get
// an admin credential" is a statement about the registry and the route together — a route that
// checked the wrong action, or checked `access_readonly` for an admin mint, fails here, and so does a
// registry that handed an operator `access_admin`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BuiltInRole, BUILT_IN_ROLES } from "@/lib/authz/registry";

vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
vi.mock("@/lib/kubeconfig-mint/request", () => ({ requestKubeconfigMint: vi.fn() }));
vi.mock("@/lib/auth/trusted-ip", () => ({ trustedClientIp: vi.fn(() => "203.0.113.7") }));

/** Every line any logger was asked to write, so a test can prove what never reached one. */
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

import { POST } from "@/app/api/cli/clusters/[id]/kubeconfig/route";
import { authorizeCli } from "@/lib/authz/guard";
import { UsageLimitError } from "@/lib/billing/usage-guard";
import { requestKubeconfigMint } from "@/lib/kubeconfig-mint/request";

const ORG = "11111111-1111-4111-8111-111111111111";
const CLUSTER = "44444444-4444-4444-8444-444444444444";
const MINT = "77777777-7777-4777-8777-777777777777";
const JOB = "88888888-8888-4888-8888-888888888888";
const KEY = "Qw9LmFlmUUWmsbonQCRIe9ZvA6LdV313U8aNfX0AwAw";

let role: BuiltInRole = "operator";
let userSeq = 0;
let user = "";

/** A fresh user per test, so the per-user rate-limit bucket never carries between tests. */
function nextUser(): string {
	userSeq += 1;
	return `00000000-0000-4000-8000-${String(userSeq).padStart(12, "0")}`;
}

/** Whether the built-in role `r` holds `cluster:<action>` in the real registry. */
function roleHolds(r: BuiltInRole, action: string): boolean {
	const keys = BUILT_IN_ROLES[r];
	return keys === "*" || keys.some((k) => k === `cluster:${action}`);
}

beforeEach(() => {
	vi.clearAllMocks();
	logged.length = 0;
	role = "operator";
	user = nextUser();
	vi.mocked(authorizeCli).mockImplementation(async (_req, action) =>
		roleHolds(role, action)
			? {
					actor: { userId: user, orgId: ORG },
					credential: "session",
					orgScope: [ORG, user],
				}
			: { error: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) },
	);
	vi.mocked(requestKubeconfigMint).mockImplementation(async (input) => ({
		ok: true,
		mint: {
			id: MINT,
			cluster_id: input.clusterId,
			job_id: JOB,
			tier: input.request.tier,
			shape: input.request.shape,
			ttl_seconds: input.request.ttl_seconds,
			status: "pending",
			expires_at: new Date("2026-10-01T12:10:00.000Z"),
		},
	}));
});

/** Posts `body` (JSON-encoded unless a string) to the route for `clusterId`. */
async function post(body: unknown, clusterId = CLUSTER): Promise<Response> {
	return POST(
		new Request(`https://console.local/api/cli/clusters/${clusterId}/kubeconfig`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id: clusterId }) },
	);
}

/** A valid request body for `tier`. */
function body(tier?: "readonly" | "admin") {
	return { ...(tier ? { tier } : {}), shape: "exec", client_public_key: KEY };
}

describe("authz — exactly the requested tier's action, before any work", () => {
	it("checks cluster:access_readonly, once, for a read-only mint (the default tier)", async () => {
		const res = await post(body());
		expect(res.status).toBe(202);
		expect(vi.mocked(authorizeCli).mock.calls.map((c) => [c[1], c[2]])).toEqual([
			["access_readonly", { type: "cluster", id: CLUSTER }],
		]);
	});

	it("checks cluster:access_admin, once, for an admin mint", async () => {
		role = "admin";
		const res = await post(body("admin"));
		expect(res.status).toBe(202);
		expect(vi.mocked(authorizeCli).mock.calls.map((c) => c[1])).toEqual(["access_admin"]);
	});

	it("an operator can mint read-only but NOT admin, and the refused mint queues nothing", async () => {
		role = "operator";
		expect((await post(body("readonly"))).status).toBe(202);
		vi.mocked(requestKubeconfigMint).mockClear();

		const res = await post(body("admin"));
		expect(res.status).toBe(403);
		expect(requestKubeconfigMint).not.toHaveBeenCalled();
	});

	it.each(["readonly", "admin"] as const)("a viewer cannot mint at all (%s)", async (tier) => {
		role = "viewer";
		const res = await post(body(tier));
		expect(res.status).toBe(403);
		expect(requestKubeconfigMint).not.toHaveBeenCalled();
	});

	it("an owner and an admin can mint both tiers", async () => {
		for (const r of ["owner", "admin"] as const) {
			for (const tier of ["readonly", "admin"] as const) {
				role = r;
				user = nextUser();
				expect((await post(body(tier))).status).toBe(202);
			}
		}
	});

	it("an unauthenticated caller with a bad body hears 401, not what is wrong with the body", async () => {
		vi.mocked(authorizeCli).mockResolvedValueOnce({
			error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
		});
		const res = await post("{not json");
		expect(res.status).toBe(401);
		expect(vi.mocked(authorizeCli).mock.calls[0][1]).toBe("access_readonly");
	});
});

describe("request validation", () => {
	it("refuses a body that names the cluster's identity (strict: mint-bind)", async () => {
		const res = await post({ ...body(), server: "https://evil.example" });
		expect(res.status).toBe(400);
		expect(requestKubeconfigMint).not.toHaveBeenCalled();
	});

	it("does not buffer an oversized body before authenticating: it is refused as unparseable", async () => {
		// A VALID body padded with whitespace past the 4 KiB bound: only the bound refuses it.
		const res = await post(`${JSON.stringify(body())}${" ".repeat(5000)}`);
		expect(res.status).toBe(400);
		expect(vi.mocked(authorizeCli).mock.calls[0][1]).toBe("access_readonly");
		expect(requestKubeconfigMint).not.toHaveBeenCalled();
	});

	it("refuses a TTL over 8h and a padded public key", async () => {
		expect((await post({ ...body(), ttl_seconds: 28_801 })).status).toBe(400);
		expect((await post({ ...body(), client_public_key: `${KEY}=` })).status).toBe(400);
		expect(requestKubeconfigMint).not.toHaveBeenCalled();
	});

	it("answers a malformed cluster id as not found, without queueing", async () => {
		const res = await post(body(), "not-a-uuid");
		expect(res.status).toBe(404);
		expect(requestKubeconfigMint).not.toHaveBeenCalled();
	});

	it("passes the parsed request, the client, the credential kind and the trusted IP through", async () => {
		await post({ ...body("readonly"), ttl_seconds: 900 });
		expect(requestKubeconfigMint).toHaveBeenCalledWith({
			actor: { userId: user, orgId: ORG },
			clusterId: CLUSTER,
			request: { tier: "readonly", ttl_seconds: 900, shape: "exec", client_public_key: KEY },
			client: "cli",
			credential: { kind: "session" },
			sourceIp: "203.0.113.7",
		});
	});
});

describe("a service token (#5310)", () => {
	const TOKEN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

	beforeEach(() => {
		role = "owner";
		vi.mocked(authorizeCli).mockResolvedValue({
			actor: { userId: user, orgId: ORG },
			credential: "service_token",
			serviceTokenId: TOKEN_ID,
			orgScope: [ORG],
		});
	});

	it("binds the mint to the token's own id, not only to the person who minted it", async () => {
		await post(body("readonly"));
		expect(requestKubeconfigMint).toHaveBeenCalledWith(
			expect.objectContaining({ credential: { kind: "service_token", tokenId: TOKEN_ID } }),
		);
	});

	it("answers an admin refusal with 403 and a sentence that says what to do instead", async () => {
		vi.mocked(requestKubeconfigMint).mockResolvedValueOnce({ ok: false, refusal: "admin-needs-a-person" });
		const res = await post(body("admin"));
		expect(res.status).toBe(403);
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(await res.json()).toEqual({
			error: "A service token can mint only a read-only kubeconfig. Admin kubeconfigs are for people: sign in with `alethia login` and request it as yourself",
		});
	});
});

describe("outcomes", () => {
	it("answers 202 with the queued mint on the wire contract", async () => {
		const res = await post(body());
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({
			mint: {
				id: MINT,
				cluster_id: CLUSTER,
				job_id: JOB,
				tier: "readonly",
				shape: "exec",
				ttl_seconds: 3600,
				status: "pending",
				expires_at: "2026-10-01T12:10:00.000Z",
			},
		});
	});

	it.each([
		["admin-needs-a-person", 403],
		["not-found", 404],
		["not-provisioned", 409],
		["unsupported-cloud", 422],
		["static-only", 422],
		["shared-cluster", 422],
	] as const)("maps %s to %i", async (refusal, status) => {
		vi.mocked(requestKubeconfigMint).mockResolvedValueOnce({ ok: false, refusal });
		expect((await post(body())).status).toBe(status);
	});

	it("answers a shared cluster with the runner's own sentence, byte for byte (#5327)", async () => {
		vi.mocked(requestKubeconfigMint).mockResolvedValueOnce({ ok: false, refusal: "shared-cluster" });
		const res = await post(body());
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({
			error: "Kubeconfig mints are not available for an environment placed on a shared cluster.",
		});
		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	it("maps a usage-limit refusal to 402 with its message", async () => {
		vi.mocked(requestKubeconfigMint).mockRejectedValueOnce(
			new UsageLimitError("Daily job quota reached", true),
		);
		const res = await post(body());
		expect(res.status).toBe(402);
		expect(await res.json()).toEqual({ error: "Daily job quota reached" });
	});

	it("rate-limits one person: the 21st request in the window is 429 and queues nothing", async () => {
		for (let i = 0; i < 20; i++) expect((await post(body())).status).toBe(202);
		const res = await post(body());
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("600");
		expect(requestKubeconfigMint).toHaveBeenCalledTimes(20);
	});

	it("marks EVERY response no-store — success, refusal, authz failure and server error", async () => {
		const responses: Response[] = [await post(body())];
		vi.mocked(requestKubeconfigMint).mockResolvedValueOnce({ ok: false, refusal: "not-found" });
		responses.push(await post(body()));
		role = "viewer";
		responses.push(await post(body()));
		role = "operator";
		responses.push(await post({}));
		vi.mocked(requestKubeconfigMint).mockRejectedValueOnce(new Error("boom"));
		responses.push(await post(body()));
		expect(responses.map((r) => r.status)).toEqual([202, 404, 403, 400, 500]);
		for (const r of responses) expect(r.headers.get("Cache-Control")).toBe("no-store");
	});

	it("logs a server error by its name only — never the message, which can quote the statement", async () => {
		vi.mocked(requestKubeconfigMint).mockRejectedValueOnce(
			new Error(`Failed query: insert ... params: ${KEY}`),
		);
		const res = await post(body());
		expect(res.status).toBe(500);
		expect(await res.text()).not.toContain(KEY);
		expect(logged.length).toBeGreaterThan(0);
		expect(JSON.stringify(logged)).not.toContain(KEY);
	});
});
