// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the evidence server action: the actor/query seams are
// stubbed, but the real deriveGroups / facet-count / provider-bucketing logic runs,
// so the result shaping (summary passthrough, enum-driven providerOptions, provider
// filtering with untrusted-input narrowing) is exercised as the client sees it.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/queries/evidence", async (importOriginal) => ({
	// Keep the real types module shape; stub only the DB entry point.
	...(await importOriginal<typeof import("@/lib/queries/evidence")>()),
	queryOrgEvidence: vi.fn(),
}));

import { getOrgEvidence } from "@/app/server/actions/evidence";
import { CLOUD_FILTER_VALUES } from "@/components/evidence/evidence-query";
import { currentActor } from "@/lib/authz/guard";
import {
	type EvidenceEnvRow,
	type OrgEvidence,
	queryOrgEvidence,
} from "@/lib/queries/evidence";

/** Minimal environment row for shaping tests. */
function mkRow(over: Partial<EvidenceEnvRow> & { id: string }): EvidenceEnvRow {
	return {
		projectId: over.projectId ?? "p1",
		projectName: over.projectName ?? "proj",
		projectSlug: null,
		environmentId: over.id,
		environmentName: over.environmentName ?? over.id,
		stage: over.stage ?? "production",
		provider: over.provider !== undefined ? over.provider : "aws",
		region: over.region ?? "eu-west-1",
		verify: over.verify ?? null,
		drift: over.drift ?? null,
		security: over.security ?? null,
	};
}

/** An org roll-up around the given rows (summary counters kept plausible). */
function rollup(rows: EvidenceEnvRow[]): OrgEvidence {
	return {
		rows,
		waivers: [],
		summary: {
			environments: rows.length,
			verified: 0,
			warning: 0,
			failing: 0,
			notEvaluable: 0,
			unverified: rows.length,
			inSync: 0,
			drifted: 0,
			driftUnknown: rows.length,
			activeWaivers: 0,
			criticalHighVulns: 0,
			securityUnknown: rows.length,
		},
	};
}

const ORG_ACTOR = { orgId: "org-1", userId: "user-1" };

beforeEach(() => {
	vi.mocked(currentActor).mockReset();
	vi.mocked(queryOrgEvidence).mockReset();
	vi.mocked(currentActor).mockResolvedValue(ORG_ACTOR as never);
});

describe("getOrgEvidence — result shape", () => {
	it("passes the org summary through to the client", async () => {
		const ev = rollup([mkRow({ id: "e1" })]);
		vi.mocked(queryOrgEvidence).mockResolvedValue(ev);

		const result = await getOrgEvidence();
		expect(result.summary).toEqual(ev.summary);
	});

	it("lists every enum cloud as a provider option (zero counts included), no 'other' by default", async () => {
		vi.mocked(queryOrgEvidence).mockResolvedValue(
			rollup([
				mkRow({ id: "e1", provider: "aws" }),
				mkRow({ id: "e2", provider: "aws" }),
				mkRow({ id: "e3", provider: "hetzner" }),
			]),
		);

		const { providerOptions } = await getOrgEvidence();
		expect(providerOptions.map((o) => o.value)).toEqual([
			...CLOUD_FILTER_VALUES,
		]);
		const byValue = new Map(providerOptions.map((o) => [o.value, o.count]));
		expect(byValue.get("aws")).toBe(2);
		expect(byValue.get("hetzner")).toBe(1);
		expect(byValue.get("gcp")).toBe(0);
	});

	it("adds the 'other' option only when rows fall outside the enum clouds", async () => {
		vi.mocked(queryOrgEvidence).mockResolvedValue(
			rollup([
				mkRow({ id: "e1", provider: null }),
				mkRow({ id: "e2", provider: "mixed" }),
			]),
		);

		const { providerOptions } = await getOrgEvidence();
		const other = providerOptions.find((o) => o.value === "other");
		expect(other).toEqual({ value: "other", label: "Other", count: 2 });
	});
});

describe("getOrgEvidence — provider filtering", () => {
	const rows = [
		mkRow({ id: "e1", provider: "aws" }),
		mkRow({ id: "e2", provider: "gcp" }),
		mkRow({ id: "e3", provider: null }),
	];

	it("narrows rows to the selected clouds", async () => {
		vi.mocked(queryOrgEvidence).mockResolvedValue(rollup(rows));

		const result = await getOrgEvidence({ providers: ["aws"] });
		expect(result.resultCount).toBe(1);
		// Facet counts stay over the unfiltered universe.
		const aws = result.providerOptions.find((o) => o.value === "aws");
		expect(aws?.count).toBe(1);
		expect(result.total).toBe(3);
	});

	it("selects the null/unknown-provider bucket via 'other'", async () => {
		vi.mocked(queryOrgEvidence).mockResolvedValue(rollup(rows));

		const result = await getOrgEvidence({ providers: ["other"] });
		expect(result.resultCount).toBe(1);
		expect(result.groups.flatMap((g) => g.rows)[0]?.environmentId).toBe("e3");
	});

	it("ignores unknown provider strings (untrusted input cannot widen the filter)", async () => {
		vi.mocked(queryOrgEvidence).mockResolvedValue(rollup(rows));

		const result = await getOrgEvidence({
			providers: ["definitely-not-a-cloud"],
		});
		// Nothing known selected → treated as no provider filter.
		expect(result.resultCount).toBe(3);
	});
});

describe("getOrgEvidence — personal scope", () => {
	it("returns the empty roll-up without querying the DB", async () => {
		vi.mocked(currentActor).mockResolvedValue({
			orgId: "user-1",
			userId: "user-1",
		} as never);

		const result = await getOrgEvidence();
		expect(queryOrgEvidence).not.toHaveBeenCalled();
		expect(result.summary.environments).toBe(0);
		expect(result.providerOptions.map((o) => o.value)).toEqual([
			...CLOUD_FILTER_VALUES,
		]);
	});
});
