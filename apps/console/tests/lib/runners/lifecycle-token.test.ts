// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The claim-time token issue for runner-lifecycle jobs (lib/runners/lifecycle-token.ts): which job
// types get one, when it is refused, and that the hash stored on the target row is the hash of the
// plaintext handed back — on a guarded UPDATE whose WHERE names the target, a self-operated runner and
// the job's organization.

import { is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { provisionJobType } from "@/lib/db/schema/enums";
import { hashRunnerToken } from "@/lib/runners/auth";
import {
	issueLifecycleRunnerToken,
	jobNeedsRunnerToken,
	snapshotWithoutRunnerToken,
	snapshotWithRunnerToken,
	unheldRunnerTokenHash,
} from "@/lib/runners/lifecycle-token";

const TARGET = "4f0c1d52-7a1e-4c55-9d0b-2b7f6a1e9c30";
const EXECUTOR = "9b2e6c11-3f4a-4e7d-8a51-0c6d2e9f4b17";

/** One recorded `update(table).set(values).where(cond)`. */
interface UpdateCall {
	table: unknown;
	values: Record<string, unknown>;
	where: unknown;
}

/** A drizzle stand-in for the one guarded UPDATE: records it and answers `returning` with `rows`. */
function fakeDb(rows: { id: string }[]): { db: Db; updates: UpdateCall[] } {
	const updates: UpdateCall[] = [];
	const db = {
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: (where: unknown) => {
					updates.push({ table, values, where });
					return { returning: () => Promise.resolve(rows) };
				},
			}),
		}),
	};
	// The stand-in implements only the chain this module calls; the Db type is far wider.
	return { db: db as unknown as Db, updates };
}

/** A claimed DEPLOY_RUNNER job naming TARGET in org-1. */
function job(overrides: Partial<Parameters<typeof issueLifecycleRunnerToken>[1]> = {}) {
	return {
		job_type: "DEPLOY_RUNNER" as const,
		org_id: "org-1",
		user_id: "user-1",
		config_snapshot: { runner_id: TARGET, runner_name: "edge" },
		...overrides,
	};
}

/** The SQL text and parameters of a recorded WHERE. */
function rendered(cond: unknown): { sql: string; params: unknown[] } {
	if (!is(cond, SQL)) throw new Error("the update was not given a SQL condition");
	return new PgDialect().sqlToQuery(cond);
}

describe("jobNeedsRunnerToken", () => {
	it("is true for exactly DEPLOY_RUNNER and UPDATE_RUNNER", () => {
		const needing = provisionJobType.enumValues.filter(jobNeedsRunnerToken).sort();
		expect(needing).toEqual(["DEPLOY_RUNNER", "UPDATE_RUNNER"]);
	});
});

describe("issueLifecycleRunnerToken", () => {
	it.each(["DEPLOY_RUNNER", "UPDATE_RUNNER"] as const)(
		"issues a %s token whose hash is what the target row now stores",
		async (jobType) => {
			const { db, updates } = fakeDb([{ id: TARGET }]);
			const res = await issueLifecycleRunnerToken(db, job({ job_type: jobType }), EXECUTOR);

			expect(res.kind).toBe("issued");
			if (res.kind !== "issued") return;
			expect(res.token).toMatch(/^[0-9a-f]{64}$/);
			expect(updates).toHaveLength(1);
			expect(updates[0].table).toBe(runners);
			expect(updates[0].values).toEqual({ token_hash: hashRunnerToken(res.token) });
		},
	);

	it("guards the UPDATE on the target id, a self-operated runner and the job's org", async () => {
		const { db, updates } = fakeDb([{ id: TARGET }]);
		await issueLifecycleRunnerToken(db, job(), EXECUTOR);

		const { sql, params } = rendered(updates[0].where);
		expect(params).toContain(TARGET);
		expect(params).toContain("self");
		expect(params).toContain("org-1");
		expect(sql).toContain('"runners"."operator"');
		expect(sql).toContain('"runners"."org_id"');
		// The legacy personal-org arm binds the runner's owner to the job's creator.
		expect(params).toContain("user-1");
		expect(sql).toContain('"runners"."user_id"');
	});

	it("mints a different token on every claim", async () => {
		const a = await issueLifecycleRunnerToken(fakeDb([{ id: TARGET }]).db, job(), EXECUTOR);
		const b = await issueLifecycleRunnerToken(fakeDb([{ id: TARGET }]).db, job(), EXECUTOR);
		expect(a.kind === "issued" && b.kind === "issued" && a.token !== b.token).toBe(true);
	});

	it("issues nothing, and touches no row, for any other job type", async () => {
		for (const jobType of provisionJobType.enumValues) {
			if (jobNeedsRunnerToken(jobType)) continue;
			const { db, updates } = fakeDb([{ id: TARGET }]);
			const res = await issueLifecycleRunnerToken(db, job({ job_type: jobType }), EXECUTOR);
			expect(res).toEqual({ kind: "not-needed" });
			expect(updates).toHaveLength(0);
		}
	});

	it.each([
		["no runner id", { config_snapshot: {} }],
		["a runner id that is not a uuid", { config_snapshot: { runner_id: "r-1" } }],
		["no organization", { org_id: null }],
	])("refuses a job with %s, before touching any row", async (_label, overrides) => {
		const { db, updates } = fakeDb([{ id: TARGET }]);
		const res = await issueLifecycleRunnerToken(db, job(overrides), EXECUTOR);
		expect(res.kind).toBe("refused");
		expect(updates).toHaveLength(0);
	});

	it("refuses when the claiming runner is the target itself", async () => {
		const { db, updates } = fakeDb([{ id: TARGET }]);
		const res = await issueLifecycleRunnerToken(db, job(), TARGET);
		expect(res).toEqual({ kind: "refused", reason: "a runner cannot run its own lifecycle job" });
		expect(updates).toHaveLength(0);
	});

	it("refuses when no row passes the guard (gone, managed, or another org's)", async () => {
		const { db } = fakeDb([]);
		const res = await issueLifecycleRunnerToken(db, job(), EXECUTOR);
		expect(res.kind).toBe("refused");
	});
});

describe("unheldRunnerTokenHash", () => {
	it("is a well-formed hash, fresh on every call", () => {
		const a = unheldRunnerTokenHash();
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(unheldRunnerTokenHash()).not.toBe(a);
	});
});

describe("snapshot helpers", () => {
	it("adds the token to a copy and strips it from a copy, leaving the input alone", () => {
		const stored = { runner_id: TARGET, region: "eu-central-1" };
		const served = snapshotWithRunnerToken(stored, "tok");
		expect(served).toEqual({ runner_id: TARGET, region: "eu-central-1", runner_token: "tok" });
		expect(stored).not.toHaveProperty("runner_token");

		const copied = snapshotWithoutRunnerToken(served);
		expect(copied).toEqual(stored);
		expect(served.runner_token).toBe("tok");
	});
});
