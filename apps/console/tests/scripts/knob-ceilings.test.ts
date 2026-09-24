// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `ceiling:` section of the knob ledger (#4320) is a DECISION section, which makes it the easiest
// place to launder a defect: move an inconvenient `dead:` entry across with a confident sentence and
// the backlog shrinks for free. `lib/knob-ceilings.mjs` re-reads every claim an entry makes. This
// suite pins each rule going red on its own, and the real ledger going green — a guard that only ever
// reports green on the real ledger has not been shown to be a guard.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ceilingFindings, readCarriageExclusions, selfCheck } from "../../scripts/lib/knob-ceilings.mjs";

type Findings = Parameters<typeof ceilingFindings>[0];

const knob = { cloud: "alibaba", component: "dns", name: "alidns_managed_certificate" };
const entry = { cloud: "alibaba", component: "dns", knob: "alidns_managed_certificate", issue: "#1824", carriage: "dns.managed_certificate" };
const base: Findings = {
	ceilings: [entry],
	declared: [knob],
	dead: [knob],
	otherLedgers: [],
	carriageExclusions: [{ field: "dns.managed_certificate", cloud: "alibaba" }],
};

/** The titles of every finding for `base` with `over` applied. */
const titles = (over: Partial<Findings>) => ceilingFindings({ ...base, ...over }).map((f) => f.title);

describe("ceilingFindings", () => {
	it("is green on a correct entry", () => {
		expect(titles({})).toEqual([]);
	});

	it("accepts a provider-docs link as evidence in place of an issue", () => {
		expect(titles({ ceilings: [{ ...entry, issue: undefined, docs: "https://docs.example.com/limits" }] })).toEqual([]);
	});

	it("fails an entry with no evidence", () => {
		expect(titles({ ceilings: [{ ...entry, issue: undefined }] }).join()).toMatch(/no evidence/);
	});

	it("fails when the carriage ledger does not record the same ceiling for this cloud", () => {
		expect(titles({ carriageExclusions: [{ field: "dns.managed_certificate", cloud: "hetzner" }] }).join()).toMatch(
			/no matching carriage exclusion/,
		);
	});

	it("fails when the knob becomes READ by a resource — the ceiling became wireable", () => {
		expect(titles({ dead: [] }).join()).toMatch(/became wireable/);
	});

	it("fails when the knob is no longer declared", () => {
		expect(titles({ declared: [], dead: [] }).join()).toMatch(/not declared/);
	});

	it("fails a knob recorded in two sections", () => {
		expect(titles({ otherLedgers: [{ cloud: "alibaba", component: "dns", knob: "alidns_managed_certificate" }] }).join()).toMatch(
			/also listed/,
		);
	});

	it("carries its own self-check, which passes", () => {
		expect(() => selfCheck()).not.toThrow();
	});
});

describe("readCarriageExclusions", () => {
	it("reads the real ledger's exclusions, including the one the alibaba ceiling cites", () => {
		const text = readFileSync("../../infra/config-carriage-exclusions.yaml", "utf8");
		const rows = readCarriageExclusions(text);
		expect(rows.length).toBeGreaterThan(10);
		expect(rows.some((r) => r.field === "dns.managed_certificate" && r.cloud === "alibaba")).toBe(true);
	});

	it("does not let a `baseline:` or `wired:` entry stand in for a ceiling", () => {
		const rows = readCarriageExclusions("exclusions:\n  - field: a.b\n    cloud: x\nwired:\n  - field: c.d\n    cloud: x\n");
		expect(rows.map((r) => r.field)).toEqual(["a.b"]);
	});
});
