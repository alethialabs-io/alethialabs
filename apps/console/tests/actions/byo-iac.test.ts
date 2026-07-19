// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the bring-your-own IaC (E3) actions: stub the authz guard, the env
// resolver, the scaler, and a table-aware thenable drizzle chain (withActorScope + getServiceDb).
// Covers the flag gate, v1 attach uniqueness, the deployed-template-state rejection, the IAC_SCAN
// queue shape, and finalizeIacScan's commit pinning (done pins, failed/not-ok clears).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/app/server/actions/resolve", () => ({ resolveActiveEnvironmentId: vi.fn() }));

import {
	attachIacSource,
	detachIacSource,
	finalizeIacScan,
	getIacSource,
	scanIacSource,
} from "@/app/server/actions/byo-iac";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb, withActorScope } from "@/lib/db";
import { jobs, projectEnvironments, projectIacSources } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";

type Rows = unknown[];
type RowsResolver = Rows | (() => Rows);

/** Table-aware thenable drizzle-ish tx wired through withActorScope AND getServiceDb (the
 * finalize path has no user session). A function resolver is called fresh per query, letting one
 * table answer differently across sequential selects. Records .values()/.set() per table. */
function setupDb(cfg: {
	select?: Map<unknown, RowsResolver>;
	insert?: Map<unknown, RowsResolver>;
}) {
	const valuesSpy = vi.fn<(table: unknown, payload: unknown) => void>();
	const setSpy = vi.fn<(table: unknown, payload: unknown) => void>();
	const deleteSpy = vi.fn<(table: unknown) => void>();

	const resolve = (map: Map<unknown, RowsResolver> | undefined, table: unknown): Rows => {
		const v = map?.get(table);
		if (typeof v === "function") return v();
		return v ?? [];
	};

	function makeChain(op: "select" | "insert" | "update" | "delete", table?: unknown) {
		let from = table;
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			from: (t: unknown) => {
				from = t;
				return c;
			},
			where: () => c,
			limit: () => c,
			returning: () => c,
			values: (payload: unknown) => {
				valuesSpy(from, payload);
				return c;
			},
			set: (payload: unknown) => {
				setSpy(from, payload);
				return c;
			},
			then: (res: (v: Rows) => void) =>
				res(op === "insert" ? resolve(cfg.insert, from) : op === "select" ? resolve(cfg.select, from) : []),
		});
		return c;
	}

	const db = {
		select: () => makeChain("select"),
		insert: (t: unknown) => makeChain("insert", t),
		update: (t: unknown) => makeChain("update", t),
		delete: (t: unknown) => {
			deleteSpy(t);
			return makeChain("delete", t);
		},
	};

	vi.mocked(withActorScope).mockImplementation(
		((_owner: string, cb: (tx: unknown) => unknown) => cb(db)) as never,
	);
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { valuesSpy, setSpy, deleteSpy };
}

/** Pulls the single `.values()` payload recorded against a given schema table. */
function valuesFor(spy: ReturnType<typeof vi.fn>, table: unknown): Record<string, unknown> {
	const call = spy.mock.calls.find((c) => c[0] === table);
	if (!call) throw new Error("no values() recorded for table");
	return call[1] as Record<string, unknown>;
}

/** Returns [first, rest, rest, …] across sequential queries of one table. */
function seq(first: Rows, rest: Rows): () => Rows {
	let n = 0;
	return () => (n++ === 0 ? first : rest);
}

const IAC_ROW = {
	id: "iac-1",
	project_id: "p1",
	environment_id: "env-1",
	name: "default",
	repo_url: "https://github.com/acme/infra.git",
	ref: "main",
	path: "stacks/prod",
	commit_sha: null,
	deployed_commit_sha: null,
	git_credential_id: null,
	var_values: { env: "prod" },
	enabled: true,
	scan_status: "unscanned",
	scan_report: null,
	scanned_at: null,
	status: "PENDING",
	status_message: null,
};

const OLD_FLAG = process.env.ALETHIA_BYO_IAC_ENABLED;

beforeEach(() => {
	vi.clearAllMocks();
	process.env.ALETHIA_BYO_IAC_ENABLED = "true";
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	vi.mocked(resolveActiveEnvironmentId).mockResolvedValue("env-1" as never);
});

afterEach(() => {
	if (OLD_FLAG === undefined) delete process.env.ALETHIA_BYO_IAC_ENABLED;
	else process.env.ALETHIA_BYO_IAC_ENABLED = OLD_FLAG;
});

describe("attachIacSource", () => {
	const input = {
		projectId: "p1",
		repoUrl: "https://github.com/acme/infra.git",
		ref: "main",
		path: "stacks/prod",
		varValues: { env: "prod" },
	};

	it("rejects when the feature flag is off (before any authz/db work)", async () => {
		delete process.env.ALETHIA_BYO_IAC_ENABLED;
		setupDb({});
		await expect(attachIacSource(input)).rejects.toThrow(/not enabled/);
		expect(authorize).not.toHaveBeenCalled();
		expect(withActorScope).not.toHaveBeenCalled();
	});

	it("rejects a second attach on the same Fabric (per-Fabric single source)", async () => {
		setupDb({
			select: new Map<unknown, RowsResolver>([
				[projectEnvironments, [{ fabric_id: "fab-1", status: "DRAFT" }]],
				[projectIacSources, [{ id: "iac-existing" }]],
			]),
		});
		await expect(attachIacSource(input)).rejects.toThrow(/already has an IaC source/);
	});

	// #839: the ceiling is per-Fabric — a DIFFERENT env that resolves to a Fabric already holding a
	// source is rejected too (co-Fabric envs share the single source).
	it("rejects an attach via a different env that maps to a Fabric already holding a source", async () => {
		vi.mocked(resolveActiveEnvironmentId).mockResolvedValue("env-2" as never);
		setupDb({
			select: new Map<unknown, RowsResolver>([
				// env-2 is placed on the SAME Fabric fab-1.
				[projectEnvironments, [{ fabric_id: "fab-1", status: "DRAFT" }]],
				[projectIacSources, [{ id: "iac-on-fab-1" }]],
			]),
		});
		await expect(attachIacSource(input)).rejects.toThrow(/already has an IaC source/);
	});

	// attach-over-live-state (BYOC B5.2 adversarial case): a replace-mode BYO source must
	// NOT attach to an environment that holds (or is mid-flight toward) template/BYO state —
	// it would orphan those resources. The guard set is every status that implies live or
	// possibly-half-applied state; assert EACH is rejected, not just ACTIVE (a partial guard
	// that only caught ACTIVE would silently let a QUEUED/PROVISIONING/FAILED/DESTROYING env
	// be attached-over).
	it.each(["QUEUED", "PROVISIONING", "ACTIVE", "FAILED", "DESTROYING"])(
		"rejects attach when the environment holds live/in-flight state (status=%s)",
		async (status) => {
			setupDb({
				select: new Map<unknown, RowsResolver>([
					[projectIacSources, []],
					[projectEnvironments, [{ fabric_id: "fab-1", status }]],
				]),
			});
			await expect(attachIacSource(input)).rejects.toThrow(/destroy the environment first/);
		},
	);

	it("rejects an implausible repo URL", async () => {
		setupDb({});
		await expect(attachIacSource({ ...input, repoUrl: "not a url" })).rejects.toThrow();
	});

	it("inserts the row (unscanned) and auto-queues the scan best-effort", async () => {
		const { valuesSpy } = setupDb({
			select: new Map<unknown, RowsResolver>([
				// 1st query = the uniqueness pre-check (none), later = the scan's row lookup.
				[projectIacSources, seq([], [IAC_ROW])],
				[projectEnvironments, [{ fabric_id: "fab-1", status: "DRAFT" }]],
			]),
			insert: new Map<unknown, RowsResolver>([
				[projectIacSources, [{ id: "iac-1" }]],
				[jobs, [{ id: "job-1" }]],
			]),
		});

		const r = await attachIacSource(input);
		expect(r).toEqual({ ok: true, id: "iac-1" });
		expect(authorize).toHaveBeenCalledWith("edit", { type: "project", id: "p1" });
		expect(valuesFor(valuesSpy, projectIacSources)).toMatchObject({
			project_id: "p1",
			// #839: keyed on the Fabric; environment_id kept as the attaching env (informational).
			environment_id: "env-1",
			fabric_id: "fab-1",
			repo_url: "https://github.com/acme/infra.git",
			ref: "main",
			path: "stacks/prod",
			var_values: { env: "prod" },
			enabled: true,
		});
		// the auto-queued scan reached the jobs table
		expect(valuesFor(valuesSpy, jobs)).toMatchObject({ job_type: "IAC_SCAN" });
	});

	it("still attaches when the auto-scan queue fails (best-effort)", async () => {
		setupDb({
			// The scan's row lookup finds nothing → scanIacSource throws → swallowed.
			select: new Map<unknown, RowsResolver>([
				[projectIacSources, []],
				[projectEnvironments, [{ fabric_id: "fab-1", status: "DRAFT" }]],
			]),
			insert: new Map<unknown, RowsResolver>([[projectIacSources, [{ id: "iac-1" }]]]),
		});
		await expect(attachIacSource(input)).resolves.toEqual({ ok: true, id: "iac-1" });
	});
});

describe("detachIacSource", () => {
	it("deletes a never-deployed source and works even with the flag off (the way out)", async () => {
		delete process.env.ALETHIA_BYO_IAC_ENABLED;
		const { deleteSpy } = setupDb({
			select: new Map<unknown, RowsResolver>([
				[projectIacSources, [{ deployed_commit_sha: null }]],
				[projectEnvironments, [{ fabric_id: "fab-1", status: "DRAFT" }]],
			]),
		});
		await expect(detachIacSource({ projectId: "p1" })).resolves.toEqual({ ok: true });
		expect(deleteSpy).toHaveBeenCalledWith(projectIacSources);
	});

	it("rejects detach when the env holds deployed BYO state (deployed_commit_sha set)", async () => {
		const { deleteSpy } = setupDb({
			select: new Map<unknown, RowsResolver>([
				[projectIacSources, [{ deployed_commit_sha: "cafed00d" }]],
				[projectEnvironments, [{ fabric_id: "fab-1", status: "ACTIVE" }]],
			]),
		});
		await expect(detachIacSource({ projectId: "p1" })).rejects.toThrow(
			/infrastructure deployed from its IaC source/,
		);
		expect(deleteSpy).not.toHaveBeenCalled();
	});

	it("rejects detach when the env is in an active status even if deployed_commit_sha is null", async () => {
		const { deleteSpy } = setupDb({
			select: new Map<unknown, RowsResolver>([
				[projectIacSources, [{ deployed_commit_sha: null }]],
				[projectEnvironments, [{ fabric_id: "fab-1", status: "PROVISIONING" }]],
			]),
		});
		await expect(detachIacSource({ projectId: "p1" })).rejects.toThrow(
			/destroy it before detaching/,
		);
		expect(deleteSpy).not.toHaveBeenCalled();
	});

	it("is an idempotent no-op when nothing is attached", async () => {
		const { deleteSpy } = setupDb({
			select: new Map<unknown, RowsResolver>([
				[projectEnvironments, [{ fabric_id: "fab-1", status: "DRAFT" }]],
			]),
		});
		await expect(detachIacSource({ projectId: "p1" })).resolves.toEqual({ ok: true });
		expect(deleteSpy).not.toHaveBeenCalled();
	});
});

describe("getIacSource", () => {
	it("maps the row into the UI shape", async () => {
		setupDb({
			select: new Map<unknown, RowsResolver>([
				[projectEnvironments, [{ fabric_id: "fab-1", status: "DRAFT" }]],
				[projectIacSources, [{ ...IAC_ROW, commit_sha: "deadbeef" }]],
			]),
		});
		const r = await getIacSource("p1");
		expect(r).toMatchObject({
			id: "iac-1",
			repoUrl: "https://github.com/acme/infra.git",
			path: "stacks/prod",
			commitSha: "deadbeef",
			scanStatus: "unscanned",
		});
	});

	it("returns null when the Fabric has no source", async () => {
		setupDb({
			select: new Map<unknown, RowsResolver>([
				[projectEnvironments, [{ fabric_id: "fab-1", status: "DRAFT" }]],
			]),
		});
		await expect(getIacSource("p1")).resolves.toBeNull();
	});
});

describe("scanIacSource", () => {
	it("rejects when the flag is off", async () => {
		delete process.env.ALETHIA_BYO_IAC_ENABLED;
		setupDb({});
		await expect(scanIacSource({ projectId: "p1" })).rejects.toThrow(/not enabled/);
	});

	it("queues an IAC_SCAN job with the repo coords + row identity, marks the row scanning, and notifies the scaler", async () => {
		const { valuesSpy, setSpy } = setupDb({
			select: new Map<unknown, RowsResolver>([
				[projectEnvironments, [{ fabric_id: "fab-1", status: "DRAFT" }]],
				[projectIacSources, [IAC_ROW]],
			]),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});

		const r = await scanIacSource({ projectId: "p1" });
		expect(r).toEqual({ ok: true, jobId: "job-1" });
		expect(valuesFor(valuesSpy, jobs)).toMatchObject({
			user_id: "user-1",
			org_id: "org-1",
			job_type: "IAC_SCAN",
			status: "QUEUED",
			config_snapshot: {
				repo_url: "https://github.com/acme/infra.git",
				ref: "main",
				path: "stacks/prod",
				project_id: "p1",
				environment_id: "env-1",
				fabric_id: "fab-1",
				iac_source_id: "iac-1",
			},
		});
		const set = valuesFor(setSpy, projectIacSources);
		expect(set).toMatchObject({ scan_status: "scanning" });
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	it("throws when no source is attached (no job, no scaler)", async () => {
		setupDb({
			select: new Map<unknown, RowsResolver>([
				[projectEnvironments, [{ fabric_id: "fab-1", status: "DRAFT" }]],
			]),
		});
		await expect(scanIacSource({ projectId: "p1" })).rejects.toThrow(/attach it before scanning/);
		expect(notifyScaler).not.toHaveBeenCalled();
	});
});

describe("finalizeIacScan", () => {
	const scanJob = (over: Record<string, unknown>) => ({
		id: "job-1",
		job_type: "IAC_SCAN",
		status: "SUCCESS",
		config_snapshot: { project_id: "p1", environment_id: "env-1", iac_source_id: "iac-1" },
		execution_metadata: {},
		...over,
	});
	const report = {
		ok: true,
		validated: true,
		findings: [],
		providers: ["registry.opentofu.org/hashicorp/aws"],
		modules: [],
		commit_sha: "deadbeef",
	};

	it("marks done and pins the scanned commit onto commit_sha", async () => {
		const { setSpy } = setupDb({
			select: new Map([[jobs, [scanJob({ execution_metadata: { iac_scan_result: report } })]]]),
		});
		await finalizeIacScan("job-1");
		expect(valuesFor(setSpy, projectIacSources)).toMatchObject({
			scan_status: "done",
			commit_sha: "deadbeef",
			scan_report: report,
		});
	});

	it("marks failed and clears the pin when the job failed", async () => {
		const { setSpy } = setupDb({
			select: new Map([
				[jobs, [scanJob({ status: "FAILED", execution_metadata: { iac_scan_result: report } })]],
			]),
		});
		await finalizeIacScan("job-1");
		expect(valuesFor(setSpy, projectIacSources)).toMatchObject({
			scan_status: "failed",
			commit_sha: null,
		});
	});

	it("marks failed when the report says not-ok even on job SUCCESS (fail closed)", async () => {
		const { setSpy } = setupDb({
			select: new Map([
				[
					jobs,
					[scanJob({ execution_metadata: { iac_scan_result: { ...report, ok: false } } })],
				],
			]),
		});
		await finalizeIacScan("job-1");
		expect(valuesFor(setSpy, projectIacSources)).toMatchObject({
			scan_status: "failed",
			commit_sha: null,
		});
	});

	it("ignores non-IAC_SCAN jobs", async () => {
		const { setSpy } = setupDb({
			select: new Map([[jobs, [scanJob({ job_type: "CHART_SCAN" })]]]),
		});
		await finalizeIacScan("job-1");
		expect(setSpy).not.toHaveBeenCalled();
	});
});
