// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	deriveGroups,
	hasAnySignal,
	isStale,
	lastChecked,
	matchesAnyStatus,
	matchesTriage,
	rowScore,
	stageShort,
	waiversForEnv,
	type EvidenceEnvRow,
} from "@/components/evidence/evidence-derive";
import type { OrgEvidence } from "@/lib/queries/evidence";
import type { VerifyStatus } from "@/types/jsonb.types";

const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

/** Minimal environment row for the pure-derivation tests. */
function mkRow(over: Partial<EvidenceEnvRow> & { id: string }): EvidenceEnvRow {
	return {
		projectId: over.projectId ?? "p1",
		projectName: over.projectName ?? "proj",
		projectSlug: null,
		environmentId: over.id,
		environmentName: over.environmentName ?? over.id,
		stage: over.stage ?? "production",
		provider: over.provider ?? "aws",
		region: over.region ?? "eu-west-1",
		verify: over.verify ?? null,
		drift: over.drift ?? null,
		security: over.security ?? null,
	};
}

/** A verify posture with the given verdict (report/receipt kept minimal). */
function verify(verdict: VerifyStatus): EvidenceEnvRow["verify"] {
	return {
		jobId: "job-" + verdict,
		verdict,
		evaluatedAt: NOW,
		hasReceipt: false,
		summary: { pass: 1, fail: 0, warn: 0, not_evaluable: 0 },
		report: {
			verdict,
			catalog_version: "elench-controls-0.1.0",
			provider: "aws",
			controls: [],
			summary: { pass: 1, fail: 0, warn: 0, not_evaluable: 0 },
		},
		receipt: null,
	};
}

function ev(rows: EvidenceEnvRow[]): OrgEvidence {
	return {
		rows,
		waivers: [],
		summary: {
			environments: rows.length,
			verified: rows.filter((r) => r.verify?.verdict === "pass").length,
			warning: rows.filter((r) => r.verify?.verdict === "warn").length,
			failing: rows.filter((r) => r.verify?.verdict === "fail").length,
			notEvaluable: rows.filter((r) => r.verify?.verdict === "not_evaluable")
				.length,
			unverified: rows.filter((r) => !r.verify).length,
			inSync: rows.filter((r) => r.drift?.inSync === true).length,
			drifted: rows.filter((r) => r.drift && !r.drift.inSync).length,
			driftUnknown: rows.filter((r) => !r.drift).length,
			activeWaivers: 0,
			criticalHighVulns: 0,
			securityUnknown: rows.filter((r) => !r.security?.scanned).length,
		},
	};
}

describe("rowScore", () => {
	it("ranks failing above warning above passing", () => {
		const fail = mkRow({ id: "a", verify: verify("fail") });
		const warn = mkRow({ id: "b", verify: verify("warn") });
		const pass = mkRow({ id: "c", verify: verify("pass") });
		expect(rowScore(fail)).toBeGreaterThan(rowScore(warn));
		expect(rowScore(warn)).toBeGreaterThan(rowScore(pass));
	});

	it("adds weight for drift and missing coverage", () => {
		const clean = mkRow({
			id: "a",
			verify: verify("pass"),
			drift: { inSync: true, drifted: 0, details: [], scannedAt: NOW },
			security: {
				critical: 0,
				high: 0,
				medium: 0,
				low: 0,
				scanned: true,
				scannedAt: NOW,
				reportCount: 3,
			},
		});
		const drifted = mkRow({
			id: "b",
			verify: verify("pass"),
			drift: { inSync: false, drifted: 4, details: [], scannedAt: NOW },
			security: {
				critical: 0,
				high: 0,
				medium: 0,
				low: 0,
				scanned: true,
				scannedAt: NOW,
				reportCount: 3,
			},
		});
		expect(rowScore(drifted)).toBeGreaterThan(rowScore(clean));
	});
});

describe("matchesTriage", () => {
	const waived = new Set<string>();
	it("matches by posture predicate", () => {
		const failing = mkRow({ id: "a", verify: verify("fail") });
		expect(matchesTriage(failing, "failing", waived)).toBe(true);
		expect(matchesTriage(failing, "unverified", waived)).toBe(false);
		const never = mkRow({ id: "b" });
		expect(matchesTriage(never, "unverified", waived)).toBe(true);
		expect(matchesTriage(never, "driftUnknown", waived)).toBe(true);
		expect(matchesTriage(never, "all", waived)).toBe(true);
	});
});

describe("matchesAnyStatus", () => {
	const waived = new Set<string>();
	it("matches everything when no status is selected", () => {
		const failing = mkRow({ id: "a", verify: verify("fail") });
		expect(matchesAnyStatus(failing, [], waived)).toBe(true);
	});

	it("ORs the selected statuses", () => {
		const failing = mkRow({ id: "a", verify: verify("fail") });
		const passing = mkRow({ id: "b", verify: verify("pass") });
		// failing satisfies "failing"; passing satisfies neither "failing" nor "unverified".
		expect(matchesAnyStatus(failing, ["failing", "unverified"], waived)).toBe(
			true,
		);
		expect(matchesAnyStatus(passing, ["failing", "unverified"], waived)).toBe(
			false,
		);
	});
});

describe("deriveGroups", () => {
	const rows = [
		mkRow({ id: "a", stage: "production", verify: verify("fail") }),
		mkRow({ id: "b", stage: "staging", verify: verify("pass"),
			drift: { inSync: true, drifted: 0, details: [], scannedAt: NOW },
			security: { critical: 0, high: 0, medium: 0, low: 0, scanned: true, scannedAt: NOW, reportCount: 1 } }),
		mkRow({ id: "c", stage: "development" }),
	];

	it("groups environments by project", () => {
		const { groups } = deriveGroups(ev(rows), {
			search: "",
			stages: [],
			status: [],
		});
		// rows a/b/c share the default project → one project group with all three.
		expect(groups.map((g) => g.label)).toEqual(["proj"]);
		expect(groups[0]?.rows).toHaveLength(3);
	});


	it("applies a single stage filter and reports the result count", () => {
		const { resultCount } = deriveGroups(ev(rows), {
			search: "",
			stages: ["production"],
			status: [],
		});
		expect(resultCount).toBe(1);
	});

	it("applies a multi-stage filter (OR across stages)", () => {
		const { resultCount } = deriveGroups(ev(rows), {
			search: "",
			stages: ["production", "staging"],
			status: [],
		});
		expect(resultCount).toBe(2); // a (production) + b (staging), not c (development)
	});

	it("applies a single status filter", () => {
		const { resultCount } = deriveGroups(ev(rows), {
			search: "",
			stages: [],
			status: ["unverified"],
		});
		expect(resultCount).toBe(1); // only row "c" has no verify
	});

	it("applies a multi-status filter (OR across statuses)", () => {
		const { resultCount } = deriveGroups(ev(rows), {
			search: "",
			stages: [],
			status: ["failing", "unverified"],
		});
		expect(resultCount).toBe(2); // a (failing) + c (unverified), not b (passing/in-sync)
	});

	it("searches across project / environment / region", () => {
		const { resultCount } = deriveGroups(ev(rows), {
			search: "eu-west-1",
			stages: [],
			status: [],
		});
		expect(resultCount).toBe(3);
	});
});

describe("lastChecked / isStale", () => {
	it("returns the freshest timestamp and flags stale rows", () => {
		const fresh = mkRow({ id: "a", verify: verify("pass") });
		expect(lastChecked(fresh)).toBe(NOW);
		expect(isStale(fresh)).toBe(false);

		const stale = mkRow({
			id: "b",
			drift: { inSync: true, drifted: 0, details: [], scannedAt: OLD },
		});
		expect(isStale(stale)).toBe(true);

		const never = mkRow({ id: "c" });
		expect(lastChecked(never)).toBeNull();
		expect(isStale(never)).toBe(true);
	});
});

describe("deriveGroups — waived filter + project grouping", () => {
	it("filters to environments named by an active waiver", () => {
		const rows = [
			mkRow({ id: "a", projectName: "payments", environmentName: "prod" }),
			mkRow({ id: "b", projectName: "ledger", environmentName: "prod" }),
		];
		const data: OrgEvidence = {
			...ev(rows),
			waivers: [
				{
					jobId: "w1",
					projectName: "payments",
					environmentName: "prod",
					controls: ["KEYLESS-001"],
					reason: "temp",
					by: "admin",
					expiry: null,
					active: true,
					createdAt: NOW,
				},
			],
		};
		const { resultCount } = deriveGroups(data, {
			search: "",
			stages: [],
			status: ["waived"],
		});
		expect(resultCount).toBe(1); // only the payments/prod env is waived
	});

});

describe("deriveGroups — provider filter", () => {
	// mkRow's `??` default would coerce a null provider to "aws" — override after.
	const rows = [
		mkRow({ id: "a", provider: "aws" }),
		mkRow({ id: "b", provider: "gcp" }),
		{ ...mkRow({ id: "c" }), provider: null },
		mkRow({ id: "d", provider: "mixed" }),
	];
	const base = {
		search: "",
		stages: [],
		status: [] as never[],
	};

	it("narrows to the selected clouds", () => {
		const { resultCount } = deriveGroups(ev(rows), {
			...base,
			providers: ["aws", "gcp"],
		});
		expect(resultCount).toBe(2);
	});

	it("buckets null and unknown providers under 'other'", () => {
		const { groups, resultCount } = deriveGroups(ev(rows), {
			...base,
			providers: ["other"],
		});
		expect(resultCount).toBe(2);
		expect(
			groups
				.flatMap((g) => g.rows)
				.map((r) => r.environmentId)
				.sort(),
		).toEqual(["c", "d"]);
	});

	it("omitted / empty providers match everything (back-compat)", () => {
		expect(deriveGroups(ev(rows), base).resultCount).toBe(4);
		expect(
			deriveGroups(ev(rows), { ...base, providers: [] }).resultCount,
		).toBe(4);
	});
});

describe("deriveGroups — ordering", () => {
	const healthy: Partial<EvidenceEnvRow> = {
		drift: { inSync: true, drifted: 0, details: [], scannedAt: NOW },
		security: {
			critical: 0,
			high: 0,
			medium: 0,
			low: 0,
			scanned: true,
			scannedAt: NOW,
			reportCount: 1,
		},
	};

	it("orders envs worst-first within a project, projects by their worst env", () => {
		const rows = [
			// project "alpha": all healthy
			mkRow({
				id: "a1",
				projectId: "alpha",
				projectName: "alpha",
				verify: verify("pass"),
				...healthy,
			}),
			// project "beta": a healthy env and a failing env
			mkRow({
				id: "b-ok",
				projectId: "beta",
				projectName: "beta",
				environmentName: "ok",
				verify: verify("pass"),
				...healthy,
			}),
			mkRow({
				id: "b-bad",
				projectId: "beta",
				projectName: "beta",
				environmentName: "bad",
				verify: verify("fail"),
			}),
		];
		const { groups } = deriveGroups(ev(rows), {
			search: "",
			stages: [],
			status: [],
		});
		// beta (has a failing env) sorts before alpha (all healthy).
		expect(groups.map((g) => g.label)).toEqual(["beta", "alpha"]);
		// within beta, the failing env comes first.
		expect(groups[0]?.rows.map((r) => r.environmentId)).toEqual([
			"b-bad",
			"b-ok",
		]);
	});
});

describe("hasAnySignal / waiversForEnv", () => {
	it("hasAnySignal is false only when verify, drift, and security are all absent", () => {
		expect(hasAnySignal(mkRow({ id: "none" }))).toBe(false);
		expect(hasAnySignal(mkRow({ id: "v", verify: verify("pass") }))).toBe(true);
		expect(
			hasAnySignal(
				mkRow({
					id: "d",
					drift: { inSync: true, drifted: 0, scannedAt: NOW, details: [] },
				}),
			),
		).toBe(true);
		expect(
			hasAnySignal(
				mkRow({
					id: "s",
					security: {
						critical: 0,
						high: 0,
						medium: 0,
						low: 0,
						scanned: true,
						scannedAt: NOW,
						reportCount: 1,
					},
				}),
			),
		).toBe(true);
		// An unscanned security record is not a signal.
		expect(
			hasAnySignal(
				mkRow({
					id: "u",
					security: {
						critical: 0,
						high: 0,
						medium: 0,
						low: 0,
						scanned: false,
						scannedAt: OLD,
						reportCount: 0,
					},
				}),
			),
		).toBe(false);
	});

	it("waiversForEnv matches active waivers by project + environment name", () => {
		const row = mkRow({
			id: "e1",
			projectName: "payments",
			environmentName: "production",
		});
		const waivers = [
			{
				jobId: "w1",
				projectName: "payments",
				environmentName: "production",
				controls: ["KLP-003"],
				reason: "hotfix",
				by: "borislav",
				expiry: null,
				active: true,
				createdAt: NOW,
			},
			{
				jobId: "w2",
				projectName: "payments",
				environmentName: "production",
				controls: ["NET-011"],
				reason: "expired one",
				by: "mira",
				expiry: OLD,
				active: false,
				createdAt: OLD,
			},
			{
				jobId: "w3",
				projectName: "checkout",
				environmentName: "production",
				controls: ["KLP-003"],
				reason: "other project",
				by: "mira",
				expiry: null,
				active: true,
				createdAt: NOW,
			},
		];
		expect(waiversForEnv(waivers, row).map((w) => w.jobId)).toEqual(["w1"]);
	});
});

describe("stageShort", () => {
	it("shortens the known stages and passes unknown ones through", () => {
		expect(stageShort("production")).toBe("prod");
		expect(stageShort("development")).toBe("dev");
		expect(stageShort("staging")).toBe("staging");
		expect(stageShort("qa")).toBe("qa");
	});
});
