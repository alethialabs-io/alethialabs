// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/clusters/:id/kubeconfig refuses a shared-cluster environment UP FRONT (#5327).
//
// The route AND the real lib/kubeconfig-mint/request.ts, with only the database faked: the other two
// suites each stub one of them (request-route stubs the request, request-lib calls the request with
// no route), so neither alone proves the user-visible statement — "a namespace/vcluster environment
// is a 422 with the runner's sentence, and no job was queued to learn it". The same statement runs
// against real Postgres in tests/integration/kubeconfig-mint-routes.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const CLUSTER = "44444444-4444-4444-8444-444444444444";
const KEY = "Qw9LmFlmUUWmsbonQCRIe9ZvA6LdV313U8aNfX0AwAw";

/** Every insert the request tried, by table position (job, request row, audit). */
const inserted: unknown[] = [];
/** The rows the next reads answer: the resolved cluster, then its latest deploy. */
let reads: Record<string, unknown>[] = [];

/** A select chain answering the next queued read. */
function selectChain() {
	const chain = {
		from: () => chain,
		innerJoin: () => chain,
		leftJoin: () => chain,
		where: () => chain,
		orderBy: () => chain,
		limit: async () => {
			const r = reads.shift();
			return r ? [r] : [];
		},
	};
	return chain;
}

const tx = {
	insert: () => ({
		values: (v: unknown) => {
			inserted.push(v);
			const n = inserted.length;
			const returned =
				n === 1
					? [{ id: "88888888-8888-4888-8888-888888888888" }]
					: n === 2
						? [
								{
									id: "77777777-7777-4777-8777-777777777777",
									expires_at: new Date("2026-10-01T12:10:00.000Z"),
								},
							]
						: [];
			return Object.assign(Promise.resolve(returned), { returning: async () => returned });
		},
	}),
};

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({ select: () => selectChain() }),
	withActorScope: async (_actor: unknown, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
}));
vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
// The real limiter counts in Postgres (#5309); see the fixture for what this stand-in keeps.
vi.mock("@/lib/rate-limit", async () =>
	(await import("@/tests/fixtures/memory-rate-limit")).memoryRateLimitModule(),
);
vi.mock("@/lib/auth/trusted-ip", () => ({ trustedClientIp: vi.fn(() => "203.0.113.7") }));
vi.mock("@/lib/billing/usage-guard", async (orig) => ({
	...(await orig<typeof import("@/lib/billing/usage-guard")>()),
	assertUsageAllowed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/runners/snapshot-sig", () => ({ signSnapshot: () => "sig" }));

import { POST } from "@/app/api/cli/clusters/[id]/kubeconfig/route";
import { authorizeCli } from "@/lib/authz/guard";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";

let userSeq = 0;

/** The resolved cluster row for an environment placed `placementMode`. */
function clusterIn(placementMode: string) {
	return {
		clusterId: CLUSTER,
		projectId: "55555555-5555-4555-8555-555555555555",
		environmentId: "66666666-6666-4666-8666-666666666666",
		environmentStatus: "ACTIVE",
		placementMode,
		cloudIdentityId: "99999999-9999-4999-8999-999999999999",
		provider: "aws",
	};
}

/** Posts a valid read-only exec mint request for CLUSTER. */
async function post(): Promise<Response> {
	return POST(
		new Request(`https://console.local/api/cli/clusters/${CLUSTER}/kubeconfig`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ shape: "exec", client_public_key: KEY }),
		}),
		{ params: Promise.resolve({ id: CLUSTER }) },
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	inserted.length = 0;
	userSeq += 1;
	// A fresh user per test, so the per-user rate-limit bucket never carries between tests.
	const user = `${USER.slice(0, 24)}${String(userSeq).padStart(12, "0")}`;
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { userId: user, orgId: ORG },
		credential: "session",
		orgScope: [ORG, user],
	});
});

describe("POST /api/cli/clusters/:id/kubeconfig — shared-cluster environments (#5327)", () => {
	it.each(["namespace", "vcluster"])(
		"a %s environment is a 422 with the runner's sentence, and no job is created",
		async (placement) => {
			reads = [
				clusterIn(placement),
				{ config_snapshot: { provider: "aws", placement_mode: placement } },
			];
			const res = await post();
			expect(res.status).toBe(422);
			expect(await res.json()).toEqual({
				error: "Kubeconfig mints are not available for an environment placed on a shared cluster.",
			});
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			expect(inserted).toEqual([]);
			expect(assertUsageAllowed).not.toHaveBeenCalled();
		},
	);

	it("a dedicated environment is still queued: 202, and the job is the first thing written", async () => {
		reads = [
			clusterIn("dedicated"),
			{ config_snapshot: { provider: "aws", placement_mode: "dedicated" } },
		];
		const res = await post();
		expect(res.status).toBe(202);
		expect(inserted).toHaveLength(3);
		expect(inserted[0]).toMatchObject({ job_type: "MINT_KUBECONFIG", status: "QUEUED" });
	});
});
