// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins who may read and write a hetzner-talos Fabric's admin talosconfig through
// /api/jobs/[id]/talosconfig. The talosconfig is an admin credential for the whole Fabric, so every
// widening is a security decision:
//   - GET serves the owning runner of an EXECUTING hetzner DEPLOY, or of the DESTROY of a
//     namespace/vcluster placement — whose teardown reaches the Fabric exactly as its deploy did. Before
//     #845 run 36646962419 a placement DESTROY was refused here, so no namespace or vcluster placement on
//     Hetzner could ever be deregistered.
//   - A dedicated DESTROY runs tofu against its own state and never reads it.
//   - GET also serves the owning runner of an executing MINT_KUBECONFIG job (#5283), for a DEDICATED
//     environment only: a placement's cluster is the shared Fabric.
//   - PUT stays the Fabric-owning dedicated DEPLOY's alone.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const verifyRunnerToken = vi.fn();
vi.mock("@/lib/runners/auth", () => ({
	verifyRunnerToken: (req: Request) => verifyRunnerToken(req),
}));

vi.mock("@/lib/db", () => ({
	getServiceDb: vi.fn(() => ({ _: { schema: {}, fullSchema: {} } })),
}));
import { getServiceDb } from "@/lib/db";

const TALOS = "context: fabric-a\ncontexts: {}\n";
const encryptSecret = vi.fn((_v: unknown) => "sealed-envelope");
const decryptSecret = vi.fn((_v: unknown) => ({ talosconfig: TALOS }));
vi.mock("@/lib/crypto/secrets", () => ({
	encryptSecret: (v: unknown) => encryptSecret(v),
	decryptSecret: (v: unknown) => decryptSecret(v),
}));

const RUNNER = "11111111-1111-1111-1111-111111111111";

type JobRow = {
	runner_id: string | null;
	job_type: string;
	status: string;
	environment_id: string | null;
	provider: string | null;
};
type EnvRow = { fabric_id: string | null; placement_mode: string };

/**
 * Stubs the drizzle chain: each `.limit()` resolves the next queued SELECT (job, then environment, then
 * fabric), and `.update().set()` is recorded so a test can assert whether anything was written.
 */
function mockDb(job: JobRow | undefined, env?: EnvRow, fabric?: { talos_admin_config: string | null }) {
	const selects: unknown[][] = [job ? [job] : [], env ? [env] : [], fabric ? [fabric] : []];
	const writes: unknown[] = [];
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		leftJoin: () => db,
		where: () => db,
		limit: () => Promise.resolve(selects.shift() ?? []),
		update: () => db,
		set: (v: unknown) => {
			writes.push(v);
			return { where: () => Promise.resolve() };
		},
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { writes };
}

/** An executing hetzner job owned by RUNNER. */
function job(job_type: string, overrides: Partial<JobRow> = {}): JobRow {
	return {
		runner_id: RUNNER,
		job_type,
		status: "PROCESSING",
		environment_id: "env-1",
		provider: "hetzner",
		...overrides,
	};
}

/** An environment placed on fabric-1 in the given mode. */
function env(placement_mode: string): EnvRow {
	return { fabric_id: "fabric-1", placement_mode };
}

beforeAll(async () => {
	await import("@/app/api/jobs/[id]/talosconfig/route");
}, 60_000);

/** Invokes the GET route. */
async function get(jobId = "job-1") {
	const { GET } = await import("@/app/api/jobs/[id]/talosconfig/route");
	return GET(new Request(`https://console.local/api/jobs/${jobId}/talosconfig`), {
		params: Promise.resolve({ id: jobId }),
	});
}

/** Invokes the PUT route with a talosconfig body. */
async function put(jobId = "job-1") {
	const { PUT } = await import("@/app/api/jobs/[id]/talosconfig/route");
	return PUT(
		new Request(`https://console.local/api/jobs/${jobId}/talosconfig`, {
			method: "PUT",
			body: JSON.stringify({ talosconfig: TALOS }),
		}),
		{ params: Promise.resolve({ id: jobId }) },
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	verifyRunnerToken.mockResolvedValue({ runnerId: RUNNER, tokenHash: "h" });
});

describe("GET /api/jobs/[id]/talosconfig", () => {
	it.each(["namespace", "vcluster"])("serves a %s placement's DESTROY its Fabric's talosconfig", async (mode) => {
		mockDb(job("DESTROY"), env(mode), { talos_admin_config: "sealed" });
		const res = await get();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ talosconfig: TALOS });
	});

	it.each(["namespace", "vcluster"])("still serves a %s placement's DEPLOY", async (mode) => {
		mockDb(job("DEPLOY"), env(mode), { talos_admin_config: "sealed" });
		const res = await get();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ talosconfig: TALOS });
	});

	it("refuses a dedicated DESTROY, which runs tofu and never needs the Fabric credential", async () => {
		mockDb(job("DESTROY"), env("dedicated"), { talos_admin_config: "sealed" });
		const res = await get();
		expect(res.status).toBe(403);
		expect(decryptSecret).not.toHaveBeenCalled();
	});

	it("serves a dedicated environment's MINT_KUBECONFIG its Fabric's talosconfig", async () => {
		mockDb(job("MINT_KUBECONFIG"), env("dedicated"), { talos_admin_config: "sealed" });
		const res = await get();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ talosconfig: TALOS });
	});

	it.each(["namespace", "vcluster"])("refuses a %s placement's MINT_KUBECONFIG", async (mode) => {
		mockDb(job("MINT_KUBECONFIG"), env(mode), { talos_admin_config: "sealed" });
		const res = await get();
		expect(res.status).toBe(403);
		expect(decryptSecret).not.toHaveBeenCalled();
	});

	it.each([
		["another runner's DESTROY", job("DESTROY", { runner_id: "22222222-2222-2222-2222-222222222222" }), 403],
		["an unclaimed DESTROY", job("DESTROY", { runner_id: null, status: "QUEUED" }), 403],
		["a finished DESTROY", job("DESTROY", { status: "SUCCESS" }), 403],
		["a non-hetzner DESTROY", job("DESTROY", { provider: "aws" }), 403],
		["a drift job", job("DETECT_DRIFT"), 403],
		["a DESTROY with no environment", job("DESTROY", { environment_id: null }), 409],
		["another runner's MINT_KUBECONFIG", job("MINT_KUBECONFIG", { runner_id: "22222222-2222-2222-2222-222222222222" }), 403],
		["a finished MINT_KUBECONFIG", job("MINT_KUBECONFIG", { status: "SUCCESS" }), 403],
		["a non-hetzner MINT_KUBECONFIG", job("MINT_KUBECONFIG", { provider: "aws" }), 403],
	] as const)("refuses %s", async (_name, row, status) => {
		mockDb(row, env("vcluster"), { talos_admin_config: "sealed" });
		const res = await get();
		expect(res.status).toBe(status);
		expect(JSON.stringify(await res.json())).not.toContain("fabric-a");
		expect(decryptSecret).not.toHaveBeenCalled();
	});
});

describe("PUT /api/jobs/[id]/talosconfig", () => {
	it("lets the Fabric-owning dedicated DEPLOY write", async () => {
		const { writes } = mockDb(job("DEPLOY"), env("dedicated"));
		const res = await put();
		expect(res.status).toBe(200);
		expect(writes).toHaveLength(1);
	});

	it.each(["namespace", "vcluster", "dedicated"])("never lets a %s DESTROY write", async (mode) => {
		const { writes } = mockDb(job("DESTROY"), env(mode));
		const res = await put();
		expect(res.status).toBe(403);
		expect(writes).toHaveLength(0);
		expect(encryptSecret).not.toHaveBeenCalled();
	});

	it("never lets a MINT_KUBECONFIG write, even for a dedicated environment", async () => {
		const { writes } = mockDb(job("MINT_KUBECONFIG"), env("dedicated"));
		const res = await put();
		expect(res.status).toBe(403);
		expect(writes).toHaveLength(0);
	});

	it("never lets a placement DEPLOY write", async () => {
		const { writes } = mockDb(job("DEPLOY"), env("vcluster"));
		const res = await put();
		expect(res.status).toBe(403);
		expect(writes).toHaveLength(0);
	});
});
