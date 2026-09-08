// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The READ half of the environment knowledge block. Its sibling file tests the formatter, which
// is pure; this one covers the part that decides WHICH rows the formatter is handed, and that is
// where the tenancy gate lives.
//
// The gate is the reason this file exists rather than being folded into the formatter's tests.
// `readEnvironmentFacts` resolves the environment row FIRST, joined to its project under the
// caller's scope, and only then reads the RLS-less children — cost, drift, jobs, staged changes —
// each keyed on the environment id the gate returned rather than on the caller's. An environment
// the caller cannot see must yield null and read nothing else, and a caller-supplied id must
// never be the key a child row is fetched by.
//
// The fake transaction is keyed BY TABLE, not by call order. Four of the five reads run inside one
// `Promise.all`, so an order-keyed fake would pass or fail on the order the runtime happens to
// subscribe in, and would go silently wrong the day someone reorders that array.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { scope, formData, hash } = vi.hoisted(() => ({
	scope: { withActorScope: vi.fn(), withOwnerScope: vi.fn() },
	formData: vi.fn(),
	hash: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
	withActorScope: scope.withActorScope,
	withOwnerScope: scope.withOwnerScope,
}));
vi.mock("@/app/server/actions/projects", () => ({ getProjectAsFormData: formData }));
vi.mock("@/lib/promotions/diff", () => ({ structuralHash: hash }));
vi.mock("@/lib/ai/org-agent-context-flag", () => ({ orgAgentContextEnabled: () => true }));

import {
	buildEnvironmentKnowledge,
	readEnvironmentFacts,
} from "@/lib/ai/environment-knowledge";
import {
	environmentCost,
	environmentDrift,
	jobs,
	projectChanges,
	projectEnvironments,
} from "@/lib/db/schema";

const ACTOR = { userId: "u1", orgId: "o1" };
const PROJECT = "11111111-1111-1111-1111-111111111111";
const ENV = "3f7c1a2e-8b4d-4c6e-9a1b-2d3e4f5a6b7c";

/**
 * The joined environment row the gate returns. Declared rather than inferred: inferring it from
 * the literal below narrows `region` to `string` and `deployedHash` to `null`, so the two cases
 * that matter most — an environment with no region of its own, and one that has been deployed —
 * would not type-check as overrides.
 */
interface EnvRow {
	id: string;
	name: string;
	stage: string;
	status: string;
	region: string | null;
	isDefault: boolean;
	deployedHash: string | null;
	projectRegion: string | null;
}

const envRow: EnvRow = {
	id: ENV,
	name: "prod-eu",
	stage: "production",
	status: "ACTIVE",
	region: "eu-central-1",
	isDefault: false,
	deployedHash: null,
	projectRegion: "eu-west-1",
};

/**
 * A drizzle-ish chain that answers by the table `.from()` names, and records the `where` clauses it
 * was given so a test can assert the gate keyed on the right ids.
 */
function mockTx(rows: Map<unknown, unknown[]>) {
	const seen: unknown[] = [];

	// Each `select()` starts its OWN chain, holding its own table. A single shared object with one
	// mutable `table` field looks equivalent and is not: four of these run inside one `Promise.all`,
	// so every `.from()` runs before any `.then()` does, and the last one would decide the answer
	// for all four. The first version of this fake did that and handed the drift row to the cost
	// query.
	const chain = () => {
		let table: unknown = null;
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			from: (t: unknown) => {
				table = t;
				return c;
			},
			innerJoin: () => c,
			where: (clause: unknown) => {
				seen.push(clause);
				return c;
			},
			orderBy: () => c,
			limit: () => c,
			then: (resolve: (v: unknown) => void) => resolve(rows.get(table) ?? []),
		});
		return c;
	};

	const tx: Record<string, unknown> = { select: () => chain() };
	return { tx, seen };
}

/** Run `readEnvironmentFacts` against a fake tx returning `rows`, keyed by table. */
function withRows(rows: Map<unknown, unknown[]>) {
	const { tx, seen } = mockTx(rows);
	scope.withActorScope.mockImplementation(
		async (_actor: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
	);
	return { seen };
}

function fullRows(over: Partial<EnvRow> = {}) {
	return new Map<unknown, unknown[]>([
		[projectEnvironments, [{ ...envRow, ...over }]],
		[
			environmentCost,
			[{ monthly: 412.5, capturedAt: new Date("2026-09-01T10:00:00Z") }],
		],
		[
			environmentDrift,
			[{ inSync: false, drifted: 2, scannedAt: new Date("2026-09-06T08:30:00Z") }],
		],
		[jobs, [{ type: "DEPLOY", status: "SUCCESS", error: null }]],
		[projectChanges, [{ op: "UPDATE", componentType: "cache" }]],
	]);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("readEnvironmentFacts", () => {
	it("returns the environment's own facts, with its children attached", async () => {
		withRows(fullRows());
		const facts = await readEnvironmentFacts(ACTOR, PROJECT, ENV);

		expect(facts).not.toBeNull();
		expect(facts?.id).toBe(ENV);
		expect(facts?.name).toBe("prod-eu");
		expect(facts?.cost).toEqual({
			monthly: 412.5,
			capturedAt: "2026-09-01T10:00:00.000Z",
		});
		expect(facts?.drift).toEqual({
			inSync: false,
			drifted: 2,
			scannedAt: "2026-09-06T08:30:00.000Z",
		});
		expect(facts?.recentJobs).toHaveLength(1);
		expect(facts?.stagedChanges).toHaveLength(1);
	});

	// The gate. An environment the caller cannot see is not an empty block, it is nothing — and
	// nothing else may be read on the strength of an id the gate did not return.
	it("returns null when the environment is not visible in scope, and reads no children", async () => {
		const rows = fullRows();
		rows.set(projectEnvironments, []);
		withRows(rows);

		expect(await readEnvironmentFacts(ACTOR, PROJECT, ENV)).toBeNull();
		expect(formData).not.toHaveBeenCalled();
	});

	it("falls back to the PROJECT's region when the environment names none", async () => {
		withRows(fullRows({ region: null }));
		const facts = await readEnvironmentFacts(ACTOR, PROJECT, ENV);
		expect(facts?.region).toBe("eu-west-1");
	});

	it("an unpriced or never-scanned environment carries null, not a fabricated zero", async () => {
		const rows = fullRows();
		rows.set(environmentCost, [{ monthly: null, capturedAt: new Date() }]);
		rows.set(environmentDrift, []);
		withRows(rows);

		const facts = await readEnvironmentFacts(ACTOR, PROJECT, ENV);
		expect(facts?.cost).toBeNull();
		expect(facts?.drift).toBeNull();
	});

	// `updatePending` is a three-way answer and the third value is the one that matters: reading
	// the design can throw on a since-deleted cloud identity, and that must degrade to "unknown"
	// rather than to "matches", which would tell the model there is nothing to deploy.
	it("never deployed means no comparison is attempted at all", async () => {
		withRows(fullRows({ deployedHash: null }));
		const facts = await readEnvironmentFacts(ACTOR, PROJECT, ENV);

		expect(facts?.deployed).toBe(false);
		expect(facts?.updatePending).toBeNull();
		expect(formData).not.toHaveBeenCalled();
	});

	it("compares the live design against the deployed hash when there is one", async () => {
		withRows(fullRows({ deployedHash: "deadbeef" }));
		formData.mockResolvedValue({ formData: {} });
		hash.mockReturnValue("cafebabe");

		const facts = await readEnvironmentFacts(ACTOR, PROJECT, ENV);
		expect(facts?.deployed).toBe(true);
		expect(facts?.updatePending).toBe(true);
		expect(formData).toHaveBeenCalledWith(PROJECT, ENV);
	});

	it("an equal hash is 'matches', not 'update pending'", async () => {
		withRows(fullRows({ deployedHash: "deadbeef" }));
		formData.mockResolvedValue({ formData: {} });
		hash.mockReturnValue("deadbeef");

		const facts = await readEnvironmentFacts(ACTOR, PROJECT, ENV);
		expect(facts?.updatePending).toBe(false);
	});

	it("a failed design read degrades to unknown rather than to 'matches'", async () => {
		withRows(fullRows({ deployedHash: "deadbeef" }));
		formData.mockRejectedValue(new Error("cloud identity deleted"));

		const facts = await readEnvironmentFacts(ACTOR, PROJECT, ENV);
		expect(facts?.updatePending).toBeNull();
	});
});

describe("buildEnvironmentKnowledge", () => {
	it("hands back the environment's name so the Scope paragraph can use the user's own word", async () => {
		withRows(fullRows());
		const k = await buildEnvironmentKnowledge(ACTOR, PROJECT, ENV);

		expect(k.name).toBe("prod-eu");
		expect(k.block).toContain(ENV);
	});

	// The route drops the block when this is empty and says so in the prompt. A name of null with
	// a non-empty block would make it claim an environment it could not read.
	it("an invisible environment yields no name and no block", async () => {
		const rows = fullRows();
		rows.set(projectEnvironments, []);
		withRows(rows);

		const k = await buildEnvironmentKnowledge(ACTOR, PROJECT, ENV);
		expect(k.name).toBeNull();
		expect(k.block).toBe("");
	});
});
