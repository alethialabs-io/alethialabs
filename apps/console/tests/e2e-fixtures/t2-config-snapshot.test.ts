// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// BYOC A0.5 — snapshot-fidelity guard. Freezes the REAL console `config_snapshot` that the
// REAL buildConfigSnapshot produces for a canonical, cheap Hetzner environment, into a shared
// fixture the Go T2 harness (test/e2e) reads to prove its seeded DEPLOY snapshot has NOT
// diverged from what a real customer deploy freezes.
//
// # Why a fixture (finding #4)
//
// T2 used to seed a hand-built 5-key synthetic snapshot that could silently drift from the
// console-produced shape. The runner is Go and buildConfigSnapshot is DB-driven TypeScript, so
// the Go harness cannot call it directly. This vitest is the "shared fixture generated from the
// TS path": it drives the ACTUAL buildConfigSnapshot (via provisionProject, the same DEPLOY
// enqueue the console runs) against the same mocked-boundary tx the project-action tests use,
// captures the frozen config_snapshot, and asserts it deep-equals the committed fixture. So the
// fixture can never drift from buildConfigSnapshot without this test (which CI's turbo fan-out
// runs) going red — and the Go harness asserts fidelity against that same guarded fixture.
//
// Regenerate after an intentional snapshot-shape change:  UPDATE_FIXTURES=1 pnpm -F console test
// t2-config-snapshot

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), withScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/billing/usage-guard", () => ({ assertUsageAllowed: vi.fn() }));
vi.mock("@/lib/authz/runner-org", () => ({ assertRunnerInOrg: vi.fn() }));

import { provisionProject } from "@/app/server/actions/projects";
import { requireOwner } from "@/lib/auth/owner";
import { authorize } from "@/lib/authz/guard";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { getServiceDb, withActorScope, withScope } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	projectAddons,
	projectCluster,
	projectEnvironments,
	projectFabrics,
	projectRepositories,
	projects,
} from "@/lib/db/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/console/tests/e2e-fixtures → repo root is four levels up.
const FIXTURE = join(
	__dirname,
	"../../../../test/e2e/fixtures/t2_config_snapshot.hetzner.json",
);

type Rows = unknown[];

/** A table-aware, thenable drizzle-ish tx wired through withActorScope — the same seam the
 * project-action tests stub. Awaiting a SELECT resolves to `select.get(table)` (else []); an
 * INSERT ... returning to `insert.get(table)`. Records `.values()` payloads keyed by table. */
function setupDb(select: Map<unknown, Rows>, insert: Map<unknown, Rows>) {
	const valuesSpy = vi.fn<(table: unknown, payload: unknown) => void>();
	function makeChain(op: "select" | "insert", table?: unknown) {
		let from = table;
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			from: (t: unknown) => {
				from = t;
				return c;
			},
			leftJoin: () => c,
			innerJoin: () => c,
			where: () => c,
			limit: () => c,
			orderBy: () => c,
			onConflictDoNothing: () => c,
			returning: () => c,
			values: (payload: unknown) => {
				valuesSpy(from, payload);
				return c;
			},
			then: (res: (v: Rows) => void) =>
				res(op === "insert" ? (insert.get(from) ?? []) : (select.get(from) ?? [])),
		});
		return c;
	}
	const tx = {
		select: () => makeChain("select"),
		insert: (t: unknown) => makeChain("insert", t),
		update: () => makeChain("select"),
		delete: () => makeChain("select"),
		execute: () => Promise.resolve([{ updated: true }]),
	};
	vi.mocked(withActorScope).mockImplementation(
		((_owner: string, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	vi.mocked(withScope).mockImplementation(
		((_scope: unknown, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	vi.mocked(getServiceDb).mockReturnValue({} as never);
	return valuesSpy;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	vi.mocked(requireOwner).mockResolvedValue("user-1" as never);
	vi.mocked(assertUsageAllowed).mockResolvedValue(undefined as never);
});
afterEach(() => vi.restoreAllMocks());

/** The canonical, CHEAP Hetzner env the fixture freezes: one env (name feeds
 * environment_stage), a single-node cluster (node_desired_size 1 → the runner provisions
 * 1 worker + 1 control plane, the exact cheap shape the nightly proves), and the
 * `reloader` marketplace add-on (matches the Go harness's seedAddOns, so the resolved
 * add-on install spec is fidelity-checked). Returns a FRESH map per call so a test can
 * layer extra component rows on without leaking into the frozen shape. */
function canonicalSelect(): Map<unknown, Rows> {
	return new Map<unknown, Rows>([
			[
				projects,
				[
					{
						id: "p1",
						user_id: "user-1",
						org_id: "org-1",
						cloud_identity_id: "ci-1",
						project_name: "alethia-fixture",
						slug: "alethia-fixture",
						region: "nbg1",
						iac_version: "1.0.0",
					},
				],
			],
			[
				projectEnvironments,
				[
					{
						id: "env-1",
						name: "fixture",
						stage: "development",
						status: "DRAFT",
						is_default: true,
						region: null,
						// #837: the env is PLACED onto a Fabric. `dedicated` (the seam default + the
						// legacy env=cluster shape) → owns its Fabric 1:1, so `namespace` is null and
						// `fabric_name` == the env name → the tofu state path is byte-identical.
						fabric_id: "fab-1",
						placement_mode: "dedicated",
						namespace: null,
					},
				],
			],
			[projectFabrics, [{ id: "fab-1", project_id: "p1", name: "fixture" }]],
			[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
			[
				projectCluster,
				[
					{
						cluster_version: "",
						instance_types: [],
						node_min_size: 1,
						node_max_size: 1,
						node_desired_size: 1,
						cluster_admins: [],
						provider_config: {},
					},
				],
			],
			[
				projectAddons,
				[
					{
						addon_id: "reloader",
						source: "catalog",
						mode: "managed",
						version: null,
						values: {},
						values_yaml: null,
						enabled: true,
					},
				],
			],
	]);
}

/** Drives the REAL provisionProject → buildConfigSnapshot and returns the frozen snapshot. */
async function frozenSnapshot(select: Map<unknown, Rows>): Promise<unknown> {
	const insert = new Map<unknown, Rows>([[jobs, [{ id: "job-1" }]]]);
	const valuesSpy = setupDb(select, insert);

	await provisionProject("p1");

	const jobCall = valuesSpy.mock.calls.find((c) => c[0] === jobs);
	if (!jobCall) throw new Error("no DEPLOY job insert recorded");
	return (jobCall[1] as { config_snapshot: unknown }).config_snapshot;
}

describe("T2 config_snapshot fidelity fixture (BYOC A0.5)", () => {
	it("the REAL buildConfigSnapshot freezes the committed Hetzner shape", async () => {
		const snapshot = await frozenSnapshot(canonicalSelect());
		// Runtime secret placeholder — never part of the frozen fidelity shape.
		expect((snapshot as { git_access_token?: string }).git_access_token).toBe("");

		const serialized = `${JSON.stringify(snapshot, null, "\t")}\n`;
		if (process.env.UPDATE_FIXTURES) {
			mkdirSync(dirname(FIXTURE), { recursive: true });
			writeFileSync(FIXTURE, serialized);
		}
		expect(
			existsSync(FIXTURE),
			`fixture missing — regenerate with UPDATE_FIXTURES=1`,
		).toBe(true);
		// Deep-equal against the committed fixture: any drift between buildConfigSnapshot and the
		// shared fixture the Go harness trusts reds here (regenerate intentionally).
		expect(JSON.parse(serialized)).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
	});
});

// #1767 — the per-tier overlay path must SURVIVE the DB → snapshot trip. The defect this
// guards is the one that made the field vacuous in the first place: `apps_path` existed on
// the runner contract, rendered, and defaulted — and nothing ever SET it, so every placement
// silently synced the repository root. Presence-only assertions could not see that, so these
// assert the value round-trips AND that unset stays structurally absent (not null, not "") —
// absence is what makes `path: '.'` byte-identical to a pre-field deploy.
describe("repositories.apps_path reaches the config snapshot (#1767)", () => {
	async function repositoriesOf(row: Record<string, unknown> | null) {
		const select = canonicalSelect();
		if (row) select.set(projectRepositories, [row]);
		const snapshot = await frozenSnapshot(select);
		return (snapshot as { repositories: Record<string, unknown> }).repositories;
	}

	it("carries the overlay path when the row sets one", async () => {
		const repositories = await repositoriesOf({
			apps_destination_repo: "https://github.com/alethialabs-io/enterprise-demo",
			apps_path: "overlays/dev",
		});
		// EXHAUSTIVE, not `.apps_path`: the emitted block is the whole runner-side
		// ProjectRepositoriesConfig, so `toEqual` also fails when a future column spills into
		// the snapshot — the shape the Go struct strict-decodes is pinned, not just this key.
		expect(repositories).toEqual({
			apps_destination_repo: "https://github.com/alethialabs-io/enterprise-demo",
			apps_path: "overlays/dev",
		});
	});

	it("leaves the key ABSENT when the row is null — not null, not empty string", async () => {
		const repositories = await repositoriesOf({
			apps_destination_repo: "https://github.com/alethialabs-io/enterprise-demo",
			apps_path: null,
		});
		expect("apps_path" in repositories).toBe(false);
	});

	it("leaves the key ABSENT for an empty string — '' is the unset form, not a value", async () => {
		const repositories = await repositoriesOf({
			apps_destination_repo: "https://github.com/alethialabs-io/enterprise-demo",
			apps_path: "",
		});
		expect("apps_path" in repositories).toBe(false);
	});

	it("leaves the key ABSENT when there is no repositories row at all", async () => {
		expect("apps_path" in (await repositoriesOf(null))).toBe(false);
	});
});
