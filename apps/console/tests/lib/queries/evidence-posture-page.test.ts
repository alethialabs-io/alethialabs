// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Evidence posture table's server half (lib/queries/evidence-posture.ts, #7755): the composed
// roll-up, grouped by project and paged in memory on the keyset contract. What is locked here:
//
//   - a page's row is a PROJECT GROUP keyed by the project id, and `limit` counts groups — a project
//     is never split across two pages;
//   - the order is worst-first over the WHOLE filtered roll-up BEFORE the cut, so page one holds the
//     org's worst projects (the objection the retired `bounded` decision recorded), and the walk
//     visits every group exactly once in that order;
//   - the cursor is the keyset TEXT mode over (group sort text, project id), so ties on score and
//     name fall to the id;
//   - the facet pass is over the UNFILTERED roll-up: an active filter changes the rows, never the
//     option set or its counts; facets and universeEmpty ride page one only;
//   - a group carries the in-force waivers of its project, which the drawer reads.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { queryOrgEvidence } = vi.hoisted(() => ({ queryOrgEvidence: vi.fn() }));
vi.mock("@/lib/queries/evidence", () => ({ queryOrgEvidence }));

import type { EvidenceEnvRow, EvidenceWaiver, OrgEvidence } from "@/lib/queries/evidence";
import {
	evidenceFacets,
	evidencePosturePage,
	queryEvidencePosturePage,
	type EvidenceGroupRow,
} from "@/lib/queries/evidence-posture";
import { decodeKeysetTextCursor, type KeysetTextPageRequest } from "@/lib/queries/keyset";

/** A uuid whose trailing digits are `n` — project ids are uuids, as the cursor requires. */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A failing verify verdict — the heaviest single contribution to a row's worst-first score. */
const failing: EvidenceEnvRow["verify"] = {
	jobId: "job-f",
	verdict: "fail",
	evaluatedAt: "2026-11-20T10:00:00.000Z",
	hasReceipt: false,
	summary: { pass: 0, fail: 1, warn: 0, not_evaluable: 0 },
	report: {
		verdict: "fail",
		catalog_version: "elench-controls-0.1.0",
		provider: "aws",
		controls: [],
		summary: { pass: 0, fail: 1, warn: 0, not_evaluable: 0 },
	},
	receipt: null,
};

/** One environment row of project `p` (a uuid index); every field the derive reads is overridable. */
function env(p: number, name: string, over: Partial<EvidenceEnvRow> = {}): EvidenceEnvRow {
	return {
		projectId: uuid(p),
		projectName: `project-${String(p).padStart(2, "0")}`,
		projectSlug: null,
		environmentId: `${uuid(p)}:${name}`,
		environmentName: name,
		stage: "production",
		provider: "aws",
		region: "eu-west-1",
		verify: null,
		drift: null,
		security: null,
		...over,
	};
}

/** A roll-up around `rows` and the in-force `waivers` (the summary is not read by the pager). */
function rollup(rows: EvidenceEnvRow[], waivers: EvidenceWaiver[] = []): OrgEvidence {
	return {
		rows,
		waivers,
		summary: {
			environments: rows.length,
			verified: 0,
			warning: 0,
			failing: 0,
			notEvaluable: 0,
			unverified: 0,
			inSync: 0,
			drifted: 0,
			driftUnknown: 0,
			activeWaivers: waivers.length,
			criticalHighVulns: 0,
			securityUnknown: 0,
		},
	};
}

/**
 * Twelve projects, two environments each. Projects 1–3 have a failing environment (the worst), the
 * rest are equally unproven — so ties on score are broken by name, and two of them share a name so
 * the last tie falls to the id. Project 4 runs on gcp and its environments are staging.
 */
function org(): OrgEvidence {
	const rows: EvidenceEnvRow[] = [];
	for (let p = 1; p <= 12; p += 1) {
		const over: Partial<EvidenceEnvRow> =
			p === 4 ? { provider: "gcp", stage: "staging" } : p === 11 || p === 12 ? { projectName: "twin" } : {};
		rows.push(env(p, "dev", { ...over, ...(p <= 3 ? { verify: failing } : {}) }));
		rows.push(env(p, "prod", over));
	}
	return rollup(rows);
}

/** Walks every page of `query` at `limit`, decoding nothing by hand: each cursor goes back as minted. */
function walk(ev: OrgEvidence, limit: number, query = {}): EvidenceGroupRow[][] {
	const pages: EvidenceGroupRow[][] = [];
	let request: KeysetTextPageRequest = { limit };
	for (;;) {
		const page = evidencePosturePage(ev, query, request);
		pages.push(page.rows);
		if (page.nextCursor === null) return pages;
		const cursor = decodeKeysetTextCursor(page.nextCursor);
		if (cursor === null) throw new Error("the builder minted a cursor its own codec refuses");
		request = { cursor, limit };
		if (pages.length > 50) throw new Error("the walk did not end");
	}
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("evidencePosturePage — the grouped page", () => {
	it("page one: `limit` whole project groups, the worst first, with facets and universeEmpty", () => {
		const page = evidencePosturePage(org(), {}, { limit: 5 });
		expect(page.rows).toHaveLength(5);
		// The three projects with a failing environment lead, whatever their position in the read.
		expect(page.rows.slice(0, 3).map((g) => g.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
		// A group is whole: both of its environments, keyed by the project id.
		for (const g of page.rows) {
			expect(g.id).toBe(g.key);
			expect(g.rows).toHaveLength(2);
			expect(new Set(g.rows.map((r) => r.projectId))).toEqual(new Set([g.id]));
		}
		expect(page.nextCursor).not.toBeNull();
		expect(page.universeEmpty).toBe(false);
		expect(page.facets).not.toBeNull();
	});

	it("a cursor page starts strictly after the last group, and carries neither facets nor universeEmpty", () => {
		const ev = org();
		const first = evidencePosturePage(ev, {}, { limit: 5 });
		const cursor = decodeKeysetTextCursor(first.nextCursor ?? "");
		expect(cursor?.id).toBe(first.rows.at(-1)?.id);
		const second = evidencePosturePage(ev, {}, { cursor: cursor ?? undefined, limit: 5 });
		expect(second.rows).toHaveLength(5);
		expect(second.rows.map((g) => g.id)).not.toContain(first.rows.at(-1)?.id);
		expect(second.facets).toBeNull();
		expect(second.universeEmpty).toBeNull();
	});

	it("the walk visits every group exactly once, in the one posture order, ties on name falling to the id", () => {
		const ev = org();
		const pages = walk(ev, 5);
		expect(pages.map((p) => p.length)).toEqual([5, 5, 2]);
		const walked = pages.flat().map((g) => g.id);
		// The same order an unpaged read gives (one page holding everything).
		const whole = evidencePosturePage(ev, {}, { limit: 100 }).rows.map((g) => g.id);
		expect(walked).toEqual(whole);
		expect(new Set(walked).size).toBe(12);
		// The two "twin" projects tie on score and name: the id orders them.
		expect(walked.indexOf(uuid(11))).toBeLessThan(walked.indexOf(uuid(12)));
	});

	it("the page that reaches the end says so exactly: no cursor, not a guess", () => {
		const page = evidencePosturePage(org(), {}, { limit: 12 });
		expect(page.rows).toHaveLength(12);
		expect(page.nextCursor).toBeNull();
	});

	it("an active filter narrows the rows and leaves the facets exactly as the unfiltered page has them", () => {
		const ev = org();
		const pristine = evidencePosturePage(ev, {}, { limit: 5 });
		const filtered = evidencePosturePage(ev, { providers: ["gcp"], status: ["failing"] }, { limit: 5 });
		// Narrowed: gcp AND failing selects nothing (project 4 is gcp but not failing); gcp alone, one group.
		expect(filtered.rows).toEqual([]);
		expect(evidencePosturePage(ev, { providers: ["gcp"] }, { limit: 5 }).rows.map((g) => g.id)).toEqual([uuid(4)]);
		// The facet pass never saw the query: same options, same counts.
		expect(filtered.facets).toEqual(pristine.facets);
		expect(filtered.facets).toEqual(evidenceFacets(ev));
		expect(filtered.facets?.providerOptions.find((o) => o.value === "gcp")?.count).toBe(2);
		expect(filtered.facets?.statusOptions.find((o) => o.value === "failing")?.count).toBe(3);
		expect(filtered.facets?.stageOptions.map((o) => [o.value, o.count])).toEqual([
			["production", 22],
			["staging", 2],
		]);
		// Filtered-empty, not universe-empty: the reader does have environments.
		expect(filtered.universeEmpty).toBe(false);
	});

	it("a filter walks its own universe: the cursor of a filtered walk stays inside it", () => {
		const pages = walk(org(), 2, { stages: ["production"] });
		expect(pages.flat().map((g) => g.id)).not.toContain(uuid(4));
		expect(pages.flat()).toHaveLength(11);
	});

	it("untrusted filter values cannot widen or break the read", () => {
		const page = evidencePosturePage(org(), { providers: ["not-a-cloud"], status: ["not-a-status"] }, { limit: 100 });
		expect(page.rows).toHaveLength(12);
	});

	it("nothing in scope is the universe-empty state", () => {
		expect(evidencePosturePage(rollup([]), {}, { limit: 50 })).toEqual({
			rows: [],
			nextCursor: null,
			facets: evidenceFacets(rollup([])),
			universeEmpty: true,
		});
	});

	it("a group carries the in-force waivers of its project, and only those", () => {
		const waiver = (projectName: string, active: boolean): EvidenceWaiver => ({
			jobId: `job-${projectName}-${String(active)}`,
			projectName,
			environmentName: "prod",
			controls: ["KEYLESS-001"],
			reason: "r",
			by: "ada@example.test",
			expiry: null,
			active,
			createdAt: "2026-11-20T10:00:00.000Z",
		});
		const ev = rollup([env(1, "prod"), env(2, "prod")], [waiver("project-01", true), waiver("project-01", false), waiver("project-02", true)]);
		const groups = evidencePosturePage(ev, {}, { limit: 50 }).rows;
		const byId = new Map(groups.map((g) => [g.id, g.waivers.map((w) => w.jobId)]));
		expect(byId.get(uuid(1))).toEqual(["job-project-01-true"]);
		expect(byId.get(uuid(2))).toEqual(["job-project-02-true"]);
	});
});

describe("queryEvidencePosturePage", () => {
	it("reads the roll-up for the org over exactly the given projects, then pages it", async () => {
		queryOrgEvidence.mockResolvedValue(org());
		const page = await queryEvidencePosturePage("org-1", [uuid(1), uuid(2)], {}, { limit: 3 });
		expect(queryOrgEvidence).toHaveBeenCalledWith("org-1", [uuid(1), uuid(2)]);
		expect(page.rows.map((g) => g.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
	});
});
