// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Evidence read, moved from the `getOrgEvidence` server action onto the read router (#6126,
// ADR 0005 D1).
//
// Mocked boundary: the actor, the PDP and the roll-up query. Real: the procedure, the `query` base
// (its refusal mapping and actor binding), oRPC's input validation, and the deriveGroups /
// facet-count / provider-bucketing logic — so the result is shaped exactly as the client sees it.
// Pinned: the roll-up is asked for the ADDRESSED org over exactly the projects the PDP says the
// reader may view; the personal scope is read like any org (no "No environments yet" for a person
// with environments); the facet shaping; untrusted provider strings cannot widen the filter;
// malformed input never reaches the database; a scope refusal is a typed FORBIDDEN.

import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { currentActor, listAccessible, queryOrgEvidence } = vi.hoisted(() => ({
	currentActor: vi.fn(),
	listAccessible: vi.fn(),
	queryOrgEvidence: vi.fn(),
}));
vi.mock("@/lib/authz/guard", () => ({ currentActor }));
vi.mock("@/lib/jobs/visibility", () => ({
	viewableProjectIds: (actor: unknown) => listAccessible(actor, "view", "project"),
}));
vi.mock("@/lib/queries/evidence", () => ({ queryOrgEvidence }));

import { CLOUD_FILTER_VALUES } from "@/components/evidence/evidence-query";
import { ForbiddenError } from "@/lib/authz/types";
import type { EvidenceEnvRow, OrgEvidence } from "@/lib/queries/evidence";
import { evidenceRouter } from "@/lib/rpc/procedures/evidence";

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

/** A roll-up around the given rows (summary counters kept plausible). */
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

const ACTOR = { userId: "user-1", orgId: "org-1" };
const client = createRouterClient(evidenceRouter, { context: { actor: ACTOR } });

beforeEach(() => {
	vi.clearAllMocks();
	currentActor.mockResolvedValue(ACTOR);
	listAccessible.mockResolvedValue(["p1", "p2"]);
	queryOrgEvidence.mockResolvedValue(rollup([]));
});

describe("evidence.page — what it asks for", () => {
	it("reads the addressed org over exactly the projects the reader may view", async () => {
		await client.page({});
		expect(listAccessible).toHaveBeenCalledWith(ACTOR, "view", "project");
		expect(queryOrgEvidence).toHaveBeenCalledWith("org-1", ["p1", "p2"]);
	});

	it("reads the personal scope like any org — a person's own environments are evidence too", async () => {
		const personal = { userId: "user-1", orgId: "user-1" };
		currentActor.mockResolvedValue(personal);
		queryOrgEvidence.mockResolvedValue(rollup([mkRow({ id: "e1" })]));

		const result = await client.page({});
		expect(queryOrgEvidence).toHaveBeenCalledWith("user-1", ["p1", "p2"]);
		expect(result.summary.environments).toBe(1);
	});

	it("a reader who may view no project gets an empty roll-up asked over no projects", async () => {
		listAccessible.mockResolvedValue([]);
		await client.page({});
		expect(queryOrgEvidence).toHaveBeenCalledWith("org-1", []);
	});
});

describe("evidence.page — result shape", () => {
	it("passes the summary through", async () => {
		const ev = rollup([mkRow({ id: "e1" })]);
		queryOrgEvidence.mockResolvedValue(ev);
		expect((await client.page({})).summary).toEqual(ev.summary);
	});

	it("lists every enum cloud as a provider option (zero counts included), no 'other' by default", async () => {
		queryOrgEvidence.mockResolvedValue(
			rollup([
				mkRow({ id: "e1", provider: "aws" }),
				mkRow({ id: "e2", provider: "aws" }),
				mkRow({ id: "e3", provider: "hetzner" }),
			]),
		);
		const { providerOptions } = await client.page({});
		expect(providerOptions.map((o) => o.value)).toEqual([...CLOUD_FILTER_VALUES]);
		const byValue = new Map(providerOptions.map((o) => [o.value, o.count]));
		expect(byValue.get("aws")).toBe(2);
		expect(byValue.get("hetzner")).toBe(1);
		expect(byValue.get("gcp")).toBe(0);
	});

	it("adds the 'other' option only when rows fall outside the enum clouds", async () => {
		queryOrgEvidence.mockResolvedValue(
			rollup([mkRow({ id: "e1", provider: null }), mkRow({ id: "e2", provider: "mixed" })]),
		);
		const { providerOptions } = await client.page({});
		expect(providerOptions.find((o) => o.value === "other")).toEqual({
			value: "other",
			label: "Other",
			count: 2,
		});
	});
});

describe("evidence.page — filtering", () => {
	const rows = [
		mkRow({ id: "e1", provider: "aws" }),
		mkRow({ id: "e2", provider: "gcp" }),
		mkRow({ id: "e3", provider: null }),
	];

	it("narrows rows to the selected clouds; facet counts stay over the unfiltered roll-up", async () => {
		queryOrgEvidence.mockResolvedValue(rollup(rows));
		const result = await client.page({ providers: ["aws"] });
		expect(result.resultCount).toBe(1);
		expect(result.providerOptions.find((o) => o.value === "aws")?.count).toBe(1);
		expect(result.total).toBe(3);
	});

	it("selects the null/unknown-provider bucket via 'other'", async () => {
		queryOrgEvidence.mockResolvedValue(rollup(rows));
		const result = await client.page({ providers: ["other"] });
		expect(result.groups.flatMap((g) => g.rows).map((r) => r.environmentId)).toEqual(["e3"]);
	});

	it("ignores unknown provider and status strings (untrusted input cannot widen the filter)", async () => {
		queryOrgEvidence.mockResolvedValue(rollup(rows));
		const result = await client.page({ providers: ["not-a-cloud"], status: ["not-a-status"] });
		expect(result.resultCount).toBe(3);
	});
});

describe("evidence.page — refusals and input", () => {
	it("a malformed input never reaches the database", async () => {
		await expect(client.page({ search: "x".repeat(201) })).rejects.toBeInstanceOf(ORPCError);
		await expect(client.page({ stages: Array.from({ length: 33 }, () => "production") })).rejects.toBeInstanceOf(
			ORPCError,
		);
		expect(queryOrgEvidence).not.toHaveBeenCalled();
	});

	it("a scope refusal is a typed FORBIDDEN, not an empty roll-up and not a 500", async () => {
		currentActor.mockRejectedValue(new ForbiddenError("view", { type: "org", id: "org-1" }, "no"));
		const err = await client.page({}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ORPCError);
		expect(err instanceof ORPCError && err.code).toBe("FORBIDDEN");
		expect(queryOrgEvidence).not.toHaveBeenCalled();
	});
});
