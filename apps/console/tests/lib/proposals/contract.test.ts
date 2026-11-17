// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins the proposal contract (lib/proposals/contract.ts). Three things, in this order:
//
//   1. THE DESIGN FILE'S WORDS. `DESIGN_FILE_ACTIONS` and `DesignFileEdit` restate two Go types
//      from packages/core/designfile. A restatement nothing compares to its original is a claim,
//      so the Go sources are read here and compared: the action values with the `Action` constants
//      in compare.go, the edit's fields with the `Edit` struct in edit.go.
//      Boundary, stated: this compares NAMES. It does not check that the Go side and this console
//      agree on what a field's value may be.
//   2. THE SHAPES. A changeset that follows the contract parses unchanged, and each rule the
//      schemas state refuses the value that breaks it.
//   3. THE PURE FUNCTIONS. Keys round-trip, and each change op maps to one design-file action.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DESIGN_FILE_ACTIONS,
	type DesignFileEdit,
	decideProposalChangeSchema,
	designFileActionForOp,
	isPlacementProvider,
	PROPOSAL_CHANGE_OPS,
	PROPOSAL_DECISIONS,
	PROPOSAL_ORIGINS,
	PROPOSAL_REFUSAL_REASONS,
	type ProposalChangeset,
	type ProposalView,
	parseProposalChangeKey,
	placeProposalSchema,
	proposalChangeKey,
	proposalChangeSchema,
	proposalChangesetSchema,
} from "@/lib/proposals/contract";

const DESIGNFILE_DIR = join(__dirname, "../../../../../packages/core/designfile");

/** Reads one Go source of the design-file package. */
function goSource(name: string): string {
	return readFileSync(join(DESIGNFILE_DIR, name), "utf8");
}

const PROPOSAL_ID = "0b0e7c3a-6d0f-4a52-9d55-0f6f6f0c1a11";
const IDENTITY_ID = "5f1d2a90-3c44-4e0b-8a37-2b7d1e9c4f02";
const COMPONENT_ID = "9a3b6c1d-7e2f-4b8a-9c0d-1e2f3a4b5c6d";

/** A changeset that follows the contract: one of each op, every decision but `pending` taken. */
function changeset(): ProposalChangeset {
	return {
		proposal_id: PROPOSAL_ID,
		revision: 3,
		base_design_revision: "1a2b3c4d",
		placement: { identity_id: IDENTITY_ID, provider: "hetzner", region: "fsn1" },
		changes: [
			{
				key: "database:orders",
				op: "CREATE",
				component_type: "database",
				payload: { name: "orders", engine: "postgres" },
				why: [
					{ repo_url: "https://github.com/acme/shop-api", path: "package.json", line: 14, signal: '"pg"', verified: true },
					{ repo_url: "https://github.com/acme/shop-api", path: "README.md", signal: "Postgres", verified: false },
				],
				confidence: 0.9,
				cost: { monthly: 42.5, currency: "USD", basis: "live" },
				decision: "accepted",
			},
			{
				key: "cluster",
				op: "UPDATE",
				component_type: "cluster",
				component_id: COMPONENT_ID,
				payload: { node_min_size: 2 },
				why: [],
				confidence: 0.4,
				cost: null,
				decision: "pending",
			},
		],
	};
}

describe("the design file's words", () => {
	it("names the same actions as the Go Action constants, in the same order", () => {
		const declared = [...goSource("compare.go").matchAll(/^\tAction[A-Z]\w* Action = "([a-z_]+)"$/gm)].map(
			(m) => m[1],
		);
		expect(declared.length).toBeGreaterThan(0);
		expect([...DESIGN_FILE_ACTIONS]).toEqual(declared);
	});

	it("gives an edit the fields the Go Edit struct has", () => {
		const struct = /^type Edit struct \{\n([\s\S]*?)\n\}/m.exec(goSource("edit.go"));
		const fields = [...(struct?.[1] ?? "").matchAll(/^\t([A-Z]\w*)\s+\S/gm)].map((m) => m[1].toLowerCase());
		expect(fields.length).toBeGreaterThan(0);
		const edit: Required<DesignFileEdit> = {
			environment: "prod",
			kind: "databases",
			name: "orders",
			action: "create",
			fields: {},
		};
		expect(Object.keys(edit).sort()).toEqual([...fields].sort());
	});

	it("maps every change op to an action an edit can carry", () => {
		expect(PROPOSAL_CHANGE_OPS.map((op) => [op, designFileActionForOp(op)])).toEqual([
			["CREATE", "create"],
			["UPDATE", "update"],
			["DELETE", "remove"],
		]);
	});
});

describe("the closed lists", () => {
	it("names exactly these ops, decisions and origins", () => {
		expect([...PROPOSAL_CHANGE_OPS]).toEqual(["CREATE", "UPDATE", "DELETE"]);
		expect([...PROPOSAL_DECISIONS]).toEqual(["pending", "accepted", "edited", "rejected"]);
		expect([...PROPOSAL_ORIGINS]).toEqual(["scan", "rescan", "agent"]);
	});

	it("names exactly these refusals", () => {
		expect([...PROPOSAL_REFUSAL_REASONS]).toEqual([
			"not_found",
			"not_ready",
			"stale_revision",
			"unknown_change",
			"invalid_payload",
			"base_moved",
			"unusable_identity",
		]);
	});
});

describe("proposalChangesetSchema", () => {
	it("returns a conforming changeset unchanged", () => {
		expect(proposalChangesetSchema.parse(changeset())).toEqual(changeset());
	});

	it("accepts a changeset for a new project with no placement chosen", () => {
		const fresh = { ...changeset(), base_design_revision: null, placement: null };
		expect(proposalChangesetSchema.parse(fresh)).toEqual(fresh);
	});

	it.each([
		["a proposal id that is not a uuid", { proposal_id: "p-1" }],
		["a negative revision", { revision: -1 }],
		["a fractional revision", { revision: 1.5 }],
		["a missing base revision", { base_design_revision: undefined }],
		["a placement on a cloud that does not exist", { placement: { identity_id: IDENTITY_ID, provider: "ibm", region: "x" } }],
		["a placement with no region", { placement: { identity_id: IDENTITY_ID, provider: "aws", region: "" } }],
	])("refuses %s", (_what, override) => {
		expect(proposalChangesetSchema.safeParse({ ...changeset(), ...override }).success).toBe(false);
	});
});

describe("proposalChangeSchema", () => {
	const change = () => changeset().changes[0];

	it.each([
		["an empty key", { key: "" }],
		["an op outside the enum", { op: "REPLACE" }],
		["a decision outside the enum", { decision: "approved" }],
		["confidence above one", { confidence: 1.01 }],
		["confidence below zero", { confidence: -0.1 }],
		["a component id that is not a uuid", { component_id: "db-1" }],
		["a payload that is not an object", { payload: "name=orders" }],
		["a negative cost", { cost: { monthly: -1, currency: "USD", basis: "live" } }],
		["a cost in another currency", { cost: { monthly: 1, currency: "EUR", basis: "live" } }],
		["a cost with no stated basis", { cost: { monthly: 1, currency: "USD" } }],
		["evidence on line zero", { why: [{ repo_url: "r", path: "p", line: 0, signal: "s", verified: true }] }],
		["evidence that does not say whether it was verified", { why: [{ repo_url: "r", path: "p", signal: "s" }] }],
	])("refuses %s", (_what, override) => {
		expect(proposalChangeSchema.safeParse({ ...change(), ...override }).success).toBe(false);
	});

	it("accepts a change with no cost and no evidence", () => {
		expect(proposalChangeSchema.safeParse({ ...change(), cost: null, why: [] }).success).toBe(true);
	});
});

describe("isPlacementProvider", () => {
	it.each(["aws", "gcp", "azure", "hetzner", "alibaba"])("accepts %s", (slug) => {
		expect(isPlacementProvider(slug)).toBe(true);
	});

	it.each([["ibm"], [""], ["AWS"], ["toString"], ["constructor"], [null], [undefined], [3]])("refuses %j", (value) => {
		expect(isPlacementProvider(value)).toBe(false);
	});
});

describe("proposal change keys", () => {
	it("joins a component type and a name, and leaves a nameless kind bare", () => {
		expect(proposalChangeKey("database", "orders")).toBe("database:orders");
		expect(proposalChangeKey("cluster")).toBe("cluster");
		expect(proposalChangeKey("cluster", "")).toBe("cluster");
	});

	it.each([
		["database", "orders"],
		["cluster", undefined],
		["queue", "jobs:high"],
	])("round-trips %s / %s", (componentType, name) => {
		const parsed = parseProposalChangeKey(proposalChangeKey(componentType, name));
		expect(parsed).toEqual(name === undefined ? { componentType } : { componentType, name });
	});

	it("reads a trailing colon as a nameless kind", () => {
		expect(parseProposalChangeKey("cluster:")).toEqual({ componentType: "cluster" });
	});

	it.each([[""], [":orders"], [":"]])("refuses the key %j", (key) => {
		expect(parseProposalChangeKey(key)).toBeNull();
	});
});

describe("decideProposalChangeSchema", () => {
	const target = { proposal_id: PROPOSAL_ID, revision: 3, key: "database:orders" };

	it.each(["accepted", "rejected", "pending"])("takes a bare %s decision", (decision) => {
		expect(decideProposalChangeSchema.parse({ ...target, decision })).toEqual({ ...target, decision });
	});

	it("takes an edit with its payload", () => {
		const edit = { ...target, decision: "edited", payload: { name: "orders", engine: "mysql" } };
		expect(decideProposalChangeSchema.parse(edit)).toEqual(edit);
	});

	it("drops a payload sent with a decision that carries none", () => {
		const parsed = decideProposalChangeSchema.parse({ ...target, decision: "accepted", payload: { name: "x" } });
		expect(parsed).toEqual({ ...target, decision: "accepted" });
	});

	it.each([
		["an edit with no payload", { ...target, decision: "edited" }],
		["a decision outside the enum", { ...target, decision: "approved" }],
		["no decision", target],
		["no revision", { proposal_id: PROPOSAL_ID, key: "database:orders", decision: "accepted" }],
		["an empty key", { ...target, key: "", decision: "rejected" }],
		["a proposal id that is not a uuid", { ...target, proposal_id: "p-1", decision: "rejected" }],
	])("refuses %s", (_what, input) => {
		expect(decideProposalChangeSchema.safeParse(input).success).toBe(false);
	});
});

describe("placeProposalSchema", () => {
	const input = { proposal_id: PROPOSAL_ID, revision: 3, identity_id: IDENTITY_ID, region: "fsn1" };

	it("takes a placement", () => {
		expect(placeProposalSchema.parse(input)).toEqual(input);
	});

	it.each([
		["an identity that is not a uuid", { identity_id: "aws-prod" }],
		["an empty region", { region: "" }],
		["a negative revision", { revision: -1 }],
	])("refuses %s", (_what, override) => {
		expect(placeProposalSchema.safeParse({ ...input, ...override }).success).toBe(false);
	});
});

describe("ProposalView", () => {
	it("carries a changeset only when the proposal is ready", () => {
		const views: ProposalView[] = [
			{ state: "scanning", proposal_id: PROPOSAL_ID, origin: "scan", pending_scans: 1 },
			{ state: "failed", proposal_id: PROPOSAL_ID, origin: "rescan", failure: "The repository could not be read." },
			{ state: "ready", proposal_id: PROPOSAL_ID, origin: "agent", changeset: changeset() },
		];
		expect(views.filter((view) => "changeset" in view).map((view) => view.state)).toEqual(["ready"]);
	});
});
