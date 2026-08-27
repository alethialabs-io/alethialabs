// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The facet vocabulary is pure, so it is tested directly rather than through a query builder.
//
// What these assertions are actually protecting is the filter standard's one hard invariant:
// a facet's options come from the UNFILTERED universe, and the narrowing helpers must return
// `undefined` — not an empty array — when nothing survives, so the caller OMITS the predicate
// instead of emitting `in ()`. An empty array is truthy in JS; a builder that spreads one into
// a WHERE clause produces SQL that matches no rows, which reads on screen as "you have nothing"
// rather than "your filter was discarded". That distinction is the whole reason these return
// `undefined`, so each one is asserted on identity, not on length.

import { describe, expect, it } from "vitest";

import {
	asOptions,
	narrowTo,
	nonEmpty,
	orderedOptions,
	searchTerm,
	tally,
} from "@/lib/queries/facets";

describe("tally", () => {
	it("counts by key and skips rows the dimension does not apply to", () => {
		const rows = [
			{ status: "active" },
			{ status: "active" },
			{ status: "pending" },
			{ status: null },
			{ status: undefined },
		];
		const counts = tally(rows, (r) => r.status);
		expect([...counts.entries()]).toEqual([
			["active", 2],
			["pending", 1],
		]);
	});

	it("treats the empty string as absent, not as its own bucket", () => {
		// `if (!key) continue` — deliberate: "" is what a nullable text column reads as when it
		// was written blank, and a facet option with no label is unpickable.
		const counts = tally([{ role: "" }, { role: "admin" }], (r) => r.role);
		expect(counts.has("")).toBe(false);
		expect(counts.get("admin")).toBe(1);
	});

	it("returns an empty map for no rows", () => {
		expect(tally([], () => "x").size).toBe(0);
	});
});

describe("asOptions", () => {
	it("emits only values the universe contains, with a null label by default", () => {
		const counts = new Map([
			["b", 2],
			["a", 1],
		]);
		expect(asOptions(counts)).toEqual([
			{ value: "a", label: null, count: 1 },
			{ value: "b", label: null, count: 2 },
		]);
	});

	it("sorts by LABEL when one is supplied, not by value", () => {
		const counts = new Map([
			["u-1", 3],
			["u-2", 1],
		]);
		const labels: Record<string, string> = { "u-1": "Zoë", "u-2": "Adam" };
		expect(asOptions(counts, (v) => labels[v] ?? null).map((o) => o.value)).toEqual([
			"u-2",
			"u-1",
		]);
	});

	it("falls back to the value for entries the labeller does not know", () => {
		const counts = new Map([
			["zzz", 1],
			["mmm", 1],
		]);
		const out = asOptions(counts, (v) => (v === "zzz" ? "aaa" : null));
		expect(out.map((o) => [o.value, o.label])).toEqual([
			["zzz", "aaa"],
			["mmm", null],
		]);
	});
});

describe("orderedOptions", () => {
	it("keeps every value in the fixed order, including the ones at zero", () => {
		// A bucket nobody is in is a fact about the surface, which is why this differs from
		// asOptions: for an enum-shaped dimension the option list IS part of the meaning.
		const counts = new Map([["large", 4]]);
		expect(orderedOptions(counts, ["empty", "small", "large"])).toEqual([
			{ value: "empty", label: null, count: 0 },
			{ value: "small", label: null, count: 0 },
			{ value: "large", label: null, count: 4 },
		]);
	});

	it("ignores tallied values that are not in the order", () => {
		const counts = new Map([
			["small", 1],
			["a-bucket-that-no-longer-exists", 9],
		]);
		expect(orderedOptions(counts, ["small"])).toEqual([
			{ value: "small", label: null, count: 1 },
		]);
	});

	it("applies the labeller in place", () => {
		const out = orderedOptions(new Map([["off", 2]]), ["off"], () => "Off");
		expect(out).toEqual([{ value: "off", label: "Off", count: 2 }]);
	});
});

describe("narrowTo", () => {
	const KNOWN = ["allow", "deny"] as const;

	it("keeps only known members", () => {
		expect(narrowTo(KNOWN, ["allow", "sudo", "deny"])).toEqual(["allow", "deny"]);
	});

	it("de-duplicates while preserving first-seen order", () => {
		expect(narrowTo(KNOWN, ["deny", "allow", "deny"])).toEqual(["deny", "allow"]);
	});

	it("returns undefined — not [] — when NOTHING survives narrowing", () => {
		// The caller omits the predicate on undefined. An empty array is truthy, so returning
		// one here would build `in ()` and silently select no rows.
		expect(narrowTo(KNOWN, ["root", "; drop table users"])).toBeUndefined();
	});

	it("returns undefined for an absent or empty input", () => {
		expect(narrowTo(KNOWN, undefined)).toBeUndefined();
		expect(narrowTo(KNOWN, [])).toBeUndefined();
	});
});

describe("nonEmpty", () => {
	it("de-duplicates", () => {
		expect(nonEmpty(["a", "b", "a"])).toEqual(["a", "b"]);
	});

	it("returns undefined for absent or empty input", () => {
		expect(nonEmpty(undefined)).toBeUndefined();
		expect(nonEmpty([])).toBeUndefined();
	});

	it("does NOT narrow — it is the unbounded-vocabulary counterpart to narrowTo", () => {
		// Used where the value space is data (team ids, channel names), so anything the client
		// sends is passed through to a parameterised predicate rather than matched to a set.
		expect(nonEmpty(["anything at all"])).toEqual(["anything at all"]);
	});
});

describe("searchTerm", () => {
	it("trims", () => {
		expect(searchTerm("  db  ")).toBe("db");
	});

	it("returns undefined for whitespace-only, empty and absent input", () => {
		expect(searchTerm("   ")).toBeUndefined();
		expect(searchTerm("")).toBeUndefined();
		expect(searchTerm(undefined)).toBeUndefined();
	});
});
