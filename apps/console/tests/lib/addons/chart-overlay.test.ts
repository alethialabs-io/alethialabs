// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W5 Path A Lane 2 — the chart-overlay compose is the seam that lands a BYO chart workload's user
// config into its Helm values at deploy. These lock: setByPath never mutates its input and creates
// nested paths; inference only proposes paths for knobs the workload has; compose writes config at
// the declared path, reports unavailable knobs, and NEVER inlines a secret value.

import { describe, expect, it } from "vitest";
import type { ChartWorkloadOverlay } from "@/lib/addons/chart-overlay";
import {
	bindingKnob,
	composeChartOverlay,
	composeWorkloadConfig,
	inferValuePaths,
	isCredentialFacet,
	setByPath,
} from "@/lib/addons/chart-overlay";

describe("setByPath", () => {
	it("sets a nested value without mutating the input", () => {
		const base = { a: { keep: 1 } };
		const out = setByPath(base, "a.b.c", 5);
		expect(out).toEqual({ a: { keep: 1, b: { c: 5 } } });
		expect(base).toEqual({ a: { keep: 1 } }); // untouched
	});

	it("sets a top-level key", () => {
		expect(setByPath({}, "replicaCount", 3)).toEqual({ replicaCount: 3 });
	});

	it("overwrites a non-object intermediate segment with an object", () => {
		expect(setByPath({ a: 1 }, "a.b", 2)).toEqual({ a: { b: 2 } });
	});

	it("returns a copy for an empty path (no-op)", () => {
		const base = { a: 1 };
		const out = setByPath(base, "", 9);
		expect(out).toEqual({ a: 1 });
		expect(out).not.toBe(base);
	});

	it("refuses a prototype-polluting path (no-op, no pollution)", () => {
		const out = setByPath({}, "__proto__.polluted", true);
		expect(out).toEqual({});
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(setByPath({}, "constructor.prototype.x", 1)).toEqual({});
	});
});

describe("isCredentialFacet", () => {
	it("marks username/password/connection_string secret; endpoint/port not", () => {
		expect(isCredentialFacet("password")).toBe(true);
		expect(isCredentialFacet("username")).toBe(true);
		expect(isCredentialFacet("connection_string")).toBe(true);
		expect(isCredentialFacet("endpoint")).toBe(false);
		expect(isCredentialFacet("port")).toBe(false);
	});
});

const WORKLOAD: ChartWorkloadOverlay = {
	name: "web",
	rendered: { image: "nginx:1.27", ports: [], env_keys: [], replicas: 2 },
	config: {},
	bindings: [],
	value_paths: {},
};

describe("inferValuePaths", () => {
	it("proposes replicaCount only when the workload renders replicas", () => {
		expect(inferValuePaths(WORKLOAD).replicas).toBe("replicaCount");
		const noReplicas = {
			...WORKLOAD,
			rendered: { ...WORKLOAD.rendered, replicas: undefined },
		};
		expect(inferValuePaths(noReplicas).replicas).toBeUndefined();
	});

	it("proposes the extra-env list path", () => {
		expect(inferValuePaths(WORKLOAD).env).toBe("extraEnvVars");
	});

	it("proposes existingSecret for a credential facet, nothing for a non-secret facet", () => {
		const bound = {
			...WORKLOAD,
			bindings: [
				{
					target: { kind: "database" as const, name: "orders" },
					inject: [
						{ env: "DB_PASSWORD", from: "password" as const },
						{ env: "DB_HOST", from: "endpoint" as const },
					],
				},
			],
		};
		const paths = inferValuePaths(bound);
		expect(paths[bindingKnob("database", "orders", "password")]).toBe(
			"auth.existingSecret",
		);
		expect(
			paths[bindingKnob("database", "orders", "endpoint")],
		).toBeUndefined();
	});
});

describe("composeWorkloadConfig", () => {
	it("writes replicas + env at their declared value-paths", () => {
		const w: ChartWorkloadOverlay = {
			...WORKLOAD,
			config: { replicas: 4, env: [{ name: "LOG_LEVEL", value: "debug" }] },
			value_paths: { replicas: "replicaCount", env: "extraEnvVars" },
		};
		const { values, unavailable } = composeWorkloadConfig({ image: {} }, w);
		expect(values).toEqual({
			image: {},
			replicaCount: 4,
			extraEnvVars: [{ name: "LOG_LEVEL", value: "debug" }],
		});
		expect(unavailable).toEqual([]);
	});

	it("reports a config knob with no value-path as unavailable, writing nothing", () => {
		const w: ChartWorkloadOverlay = {
			...WORKLOAD,
			config: { replicas: 4 },
			value_paths: {}, // no path for replicas
		};
		const { values, unavailable } = composeWorkloadConfig({}, w);
		expect(values).toEqual({});
		expect(unavailable).toEqual(["replicas"]);
	});

	it("never inlines a binding secret value (bindings are not composed here)", () => {
		const w: ChartWorkloadOverlay = {
			...WORKLOAD,
			config: {},
			bindings: [
				{
					target: { kind: "database", name: "orders" },
					inject: [{ env: "DB_PASSWORD", from: "password" }],
				},
			],
			value_paths: { "bind:database:orders:password": "auth.existingSecret" },
		};
		const { values } = composeWorkloadConfig({ base: true }, w);
		// The static compose touches only config — no secret material anywhere in values.
		expect(values).toEqual({ base: true });
		expect(JSON.stringify(values)).not.toContain("password");
	});
});

describe("composeChartOverlay", () => {
	it("layers every workload's config onto the base, namespacing unavailable knobs by name", () => {
		const base = { global: { region: "eu" } };
		const workloads: ChartWorkloadOverlay[] = [
			{
				...WORKLOAD,
				name: "web",
				config: { replicas: 3 },
				value_paths: { replicas: "replicaCount" },
			},
			{
				...WORKLOAD,
				name: "worker",
				config: { replicas: 2 },
				value_paths: {}, // unavailable
			},
		];
		const { values, unavailable } = composeChartOverlay(base, workloads);
		expect(values).toEqual({ global: { region: "eu" }, replicaCount: 3 });
		expect(base).toEqual({ global: { region: "eu" } }); // base untouched
		expect(unavailable).toEqual(["worker:replicas"]);
	});
});
