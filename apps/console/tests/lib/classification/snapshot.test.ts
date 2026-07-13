// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the B1.1 classification snapshot resolver: the fold from project + environment
// assignment chips into the frozen `{ dimension_key: value_slug[] }` map. Covers the override
// semantics (environment REPLACES project per dimension, never merges), inheritance of untouched
// dimensions, de-duplication, and — load-bearing for `configuration_hash` stability — that the
// output is deterministic (sorted keys + values) regardless of input row order, and frozen.

import { describe, expect, it } from "vitest";
import { resolveClassificationSnapshot } from "@/lib/classification/snapshot";
import type { AssignedValue } from "@/lib/queries/classification";

/** Minimal AssignedValue for the resolver, which only reads `dimension_key` + `value`. */
function chip(dimension_key: string, value: string): AssignedValue {
	return {
		assignment_id: `${dimension_key}:${value}:asg`,
		dimension_id: `${dimension_key}:dim`,
		dimension_key,
		dimension_label: dimension_key,
		multi: true,
		value_id: `${dimension_key}:${value}:val`,
		value,
		value_label: value,
		color: null,
		enforcement: null,
	};
}

describe("resolveClassificationSnapshot", () => {
	it("returns an empty (frozen) map when there are no assignments", () => {
		const snap = resolveClassificationSnapshot([], []);
		expect(snap).toEqual({});
		expect(Object.isFrozen(snap)).toBe(true);
	});

	it("captures project-only classification", () => {
		const snap = resolveClassificationSnapshot(
			[chip("data-class", "pii"), chip("team", "core")],
			[],
		);
		expect(snap).toEqual({ "data-class": ["pii"], team: ["core"] });
	});

	it("captures environment-only classification", () => {
		const snap = resolveClassificationSnapshot(
			[],
			[chip("env-tier", "prod")],
		);
		expect(snap).toEqual({ "env-tier": ["prod"] });
	});

	it("lets the environment OVERRIDE the project on a shared dimension (replace, not merge)", () => {
		const snap = resolveClassificationSnapshot(
			[chip("env-tier", "dev"), chip("env-tier", "staging")],
			[chip("env-tier", "prod")],
		);
		// project's dev+staging are dropped entirely — env is the more specific scope.
		expect(snap).toEqual({ "env-tier": ["prod"] });
	});

	it("inherits project dimensions the environment doesn't touch, and adds env-only ones", () => {
		const snap = resolveClassificationSnapshot(
			[chip("data-class", "pii"), chip("team", "core")],
			[chip("env-tier", "prod"), chip("team", "platform")],
		);
		expect(snap).toEqual({
			"data-class": ["pii"], // project-only → inherited
			"env-tier": ["prod"], // env-only → added
			team: ["platform"], // shared → env overrides project ("core" dropped)
		});
	});

	it("de-duplicates repeated values within a dimension", () => {
		const snap = resolveClassificationSnapshot(
			[chip("team", "core"), chip("team", "core"), chip("team", "data")],
			[],
		);
		expect(snap).toEqual({ team: ["core", "data"] });
	});

	it("is deterministic: shuffled input row order yields byte-identical output", () => {
		const project = [
			chip("team", "data"),
			chip("data-class", "pii"),
			chip("team", "core"),
		];
		const env = [chip("env-tier", "prod"), chip("region", "eu")];
		const a = resolveClassificationSnapshot(project, env);
		const b = resolveClassificationSnapshot(
			[...project].reverse(),
			[...env].reverse(),
		);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		// keys sorted, values sorted
		expect(Object.keys(a)).toEqual(["data-class", "env-tier", "region", "team"]);
		expect(a.team).toEqual(["core", "data"]);
	});

	it("freezes the returned snapshot (immutable point-in-time capture)", () => {
		const snap = resolveClassificationSnapshot([chip("team", "core")], []);
		expect(Object.isFrozen(snap)).toBe(true);
		// The index-signature type permits arbitrary string keys at compile time, but the
		// frozen object rejects the write at runtime (strict mode) — the capture is immutable.
		expect(() => {
			snap.injected = ["x"];
		}).toThrow();
	});
});
