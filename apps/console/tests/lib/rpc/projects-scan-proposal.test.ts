// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6131 review: `projects.scanProposal` runs a model inference and meters it. A refresh of
// `/~/new?scan=` (the route prefetches it again), the client's retry and a second tab each read it
// once more — so the server keeps ONE inference per scan, and meters only the inference it ran.
// And the read only answers for a SCAN: the job it is addressed by must be an ANALYZE_REPO job the
// caller may see under the jobs rule, or it is NOT_FOUND.
//
// Mocked boundary: the guard, the jobs visibility rule (a marker predicate), the RLS transaction (a
// chain answering one row and recording its WHERE), the model and the meter.

import { SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
	const state: { row: unknown; where: unknown } = { row: undefined, where: undefined };
	return state;
});

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(async () => ({ userId: "user-1", orgId: "org-1" })),
	currentActor: vi.fn(async () => ({ userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/jobs/visibility", () => ({
	jobVisibleTo: vi.fn(async () => sql.raw("job_visible_to_reader")),
}));
vi.mock("@/lib/db", () => ({
	withActorScope: async (_actor: unknown, fn: (tx: unknown) => unknown) => {
		const tx: Record<string, unknown> = {};
		Object.assign(tx, {
			select: () => tx,
			from: () => tx,
			where: (w: unknown) => {
				db.where = w;
				return tx;
			},
			limit: () => Promise.resolve(db.row === undefined ? [] : [db.row]),
		});
		return fn(tx);
	},
}));
vi.mock("@/lib/scanner/infer", () => ({
	inferStack: vi.fn(async () => ({
		stack: { runtime: "node", needs: [] },
		model: "m",
		inputTokens: 1,
		outputTokens: 1,
		cachedInputTokens: 0,
	})),
}));
vi.mock("@/lib/billing/ai-quota", () => ({
	recordAiUsage: vi.fn(async () => undefined),
	meteringFailed: () => () => undefined,
}));
// No verified cloud account: the read answers NEEDS_SETUP once it has inferred, which is all this
// file needs — the inference and the metering happen before that answer.
vi.mock("@/app/server/actions/aws/identities", () => ({ getVerifiedCloudIdentities: vi.fn(async () => []) }));
vi.mock("@/app/server/actions/projects", () => ({ getProjectAsFormData: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: {} } }));

const { inferStack } = await import("@/lib/scanner/infer");
const { recordAiUsage } = await import("@/lib/billing/ai-quota");
const { readScanProposal, readScanStatus } = await import("@/lib/rpc/procedures/projects");

/** A scanned job's row: a digest is there. */
const scanned = (status = "SUCCESS") => ({
	status,
	execution_metadata: { repo_digest: { services: [] } },
	config_snapshot: { repo_url: "https://github.com/acme/shop" },
});

beforeEach(() => {
	vi.mocked(inferStack).mockClear();
	vi.mocked(recordAiUsage).mockClear();
	db.row = undefined;
	db.where = undefined;
});

describe("readScanProposal — one inference per scan", () => {
	it("a second read of the same scan answers from the first inference, metered once", async () => {
		db.row = scanned();
		const first = await readScanProposal("00000000-0000-4000-8000-000000000001");
		const second = await readScanProposal("00000000-0000-4000-8000-000000000001");
		expect(first).toEqual({ status: "NEEDS_SETUP", needsIdentity: true });
		expect(second).toEqual(first);
		expect(inferStack).toHaveBeenCalledTimes(1);
		expect(recordAiUsage).toHaveBeenCalledTimes(1);
	});

	it("another scan is its own inference", async () => {
		db.row = scanned();
		await readScanProposal("00000000-0000-4000-8000-000000000002");
		await readScanProposal("00000000-0000-4000-8000-000000000003");
		expect(inferStack).toHaveBeenCalledTimes(2);
	});

	it("a job the reader cannot see, or that is not a scan, is NOT_FOUND — and never inferred", async () => {
		db.row = undefined;
		expect(await readScanProposal("00000000-0000-4000-8000-000000000004")).toEqual({ status: "NOT_FOUND" });
		expect(inferStack).not.toHaveBeenCalled();
	});
});

describe("the scan reads address a SCAN the reader may see", () => {
	it.each([
		["readScanStatus", readScanStatus],
		["readScanProposal", readScanProposal],
	] as const)("%s filters on the id, the ANALYZE_REPO kind and the jobs visibility rule", async (_name, read) => {
		db.row = undefined;
		await read("00000000-0000-4000-8000-000000000005");
		expect(db.where).toBeInstanceOf(SQL);
		if (!(db.where instanceof SQL)) return;
		const where = new PgDialect().sqlToQuery(db.where);
		expect(where.sql).toContain('"jobs"."id" = $1');
		expect(where.sql).toContain('"jobs"."job_type" = $2');
		expect(where.sql).toContain("job_visible_to_reader");
		expect(where.params).toEqual(["00000000-0000-4000-8000-000000000005", "ANALYZE_REPO"]);
	});
});
