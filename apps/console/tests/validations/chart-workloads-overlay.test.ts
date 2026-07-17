// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W5 Path A (Lane 3) — the overlay validators the canvas persist action (`setChartWorkloadOverlay`)
// parses each patch field with. The config overlay is v1 replicas+env; value-paths is a knob→dot-path
// map. These pin the accept/reject shape so a bad overlay never reaches the row.

import { describe, expect, it } from "vitest";
import {
	chartWorkloadConfigSchema,
	chartWorkloadValuePathsSchema,
} from "@/lib/validations/chart-workloads";

describe("chartWorkloadConfigSchema", () => {
	it("accepts a replicas + env overlay", () => {
		const r = chartWorkloadConfigSchema.safeParse({
			replicas: 3,
			env: [{ name: "LOG_LEVEL", value: "info" }],
		});
		expect(r.success).toBe(true);
	});

	it("accepts an empty overlay (no user edits yet)", () => {
		expect(chartWorkloadConfigSchema.safeParse({}).success).toBe(true);
	});

	it("rejects a negative replica count", () => {
		expect(chartWorkloadConfigSchema.safeParse({ replicas: -1 }).success).toBe(false);
	});
});

describe("chartWorkloadValuePathsSchema", () => {
	it("accepts a knob→dot-path map", () => {
		const r = chartWorkloadValuePathsSchema.safeParse({
			replicas: "replicaCount",
			"database:orders-db": "postgresql.auth.existingSecret",
		});
		expect(r.success).toBe(true);
	});

	it("rejects a non-string path value", () => {
		expect(
			chartWorkloadValuePathsSchema.safeParse({ replicas: 3 }).success,
		).toBe(false);
	});
});
