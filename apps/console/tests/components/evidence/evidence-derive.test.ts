// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	buildMeters,
	deriveGroups,
	isStale,
	lastChecked,
	matchesTriage,
	rowScore,
	sumSeverities,
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

describe("deriveGroups", () => {
	const rows = [
		mkRow({ id: "a", stage: "production", verify: verify("fail") }),
		mkRow({ id: "b", stage: "staging", verify: verify("pass"),
			drift: { inSync: true, drifted: 0, details: [], scannedAt: NOW },
			security: { critical: 0, high: 0, medium: 0, low: 0, scanned: true, scannedAt: NOW, reportCount: 1 } }),
		mkRow({ id: "c", stage: "development" }),
	];

	it("buckets by triage: attention → gaps → healthy", () => {
		const { groups } = deriveGroups(ev(rows), {
			search: "",
			stage: "all",
			triage: "all",
			group: "triage",
			sort: "worst",
		});
		expect(groups.map((g) => g.key)).toEqual(["attention", "gaps", "healthy"]);
	});

	it("orders stage groups production → staging → development", () => {
		const { groups } = deriveGroups(ev(rows), {
			search: "",
			stage: "all",
			triage: "all",
			group: "stage",
			sort: "name",
		});
		expect(groups.map((g) => g.key)).toEqual([
			"production",
			"staging",
			"development",
		]);
	});

	it("applies the stage filter and reports the result count", () => {
		const { resultCount } = deriveGroups(ev(rows), {
			search: "",
			stage: "production",
			triage: "all",
			group: "triage",
			sort: "worst",
		});
		expect(resultCount).toBe(1);
	});

	it("applies the triage filter", () => {
		const { resultCount } = deriveGroups(ev(rows), {
			search: "",
			stage: "all",
			triage: "unverified",
			group: "triage",
			sort: "worst",
		});
		expect(resultCount).toBe(1); // only row "c" has no verify
	});

	it("searches across project / environment / region", () => {
		const { resultCount } = deriveGroups(ev(rows), {
			search: "eu-west-1",
			stage: "all",
			triage: "all",
			group: "triage",
			sort: "worst",
		});
		expect(resultCount).toBe(3);
	});
});

describe("buildMeters", () => {
	it("derives the three headline distributions", () => {
		const rows = [
			mkRow({ id: "a", verify: verify("pass") }),
			mkRow({ id: "b", verify: verify("fail") }),
		];
		const [verifyMeter, driftMeter, securityMeter] = buildMeters(ev(rows));
		expect(verifyMeter.key).toBe("verify");
		expect(verifyMeter.headNum).toBe(1); // one verified
		expect(driftMeter.key).toBe("drift");
		expect(securityMeter.key).toBe("security");
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
			stage: "all",
			triage: "waived",
			group: "triage",
			sort: "worst",
		});
		expect(resultCount).toBe(1); // only the payments/prod env is waived
	});

	it("buckets by project when grouping by project", () => {
		const rows = [
			mkRow({ id: "a", projectId: "p1", projectName: "payments" }),
			mkRow({ id: "b", projectId: "p2", projectName: "ledger" }),
			mkRow({ id: "c", projectId: "p1", projectName: "payments" }),
		];
		const { groups } = deriveGroups(ev(rows), {
			search: "",
			stage: "all",
			triage: "all",
			group: "project",
			sort: "name",
		});
		expect(groups).toHaveLength(2);
		expect(groups.map((g) => g.label)).toEqual(["ledger", "payments"]);
		expect(groups.find((g) => g.key === "p1")?.rows).toHaveLength(2);
	});
});

describe("sumSeverities", () => {
	it("sums severities only across scanned environments", () => {
		const rows = [
			mkRow({
				id: "a",
				security: {
					critical: 1,
					high: 2,
					medium: 3,
					low: 4,
					scanned: true,
					scannedAt: NOW,
					reportCount: 1,
				},
			}),
			mkRow({
				id: "b",
				security: {
					critical: 9,
					high: 9,
					medium: 9,
					low: 9,
					scanned: false, // must be ignored
					scannedAt: NOW,
					reportCount: 0,
				},
			}),
			mkRow({ id: "c" }), // no security at all
		];
		expect(sumSeverities(rows)).toEqual({
			critical: 1,
			high: 2,
			medium: 3,
			low: 4,
		});
	});
});
