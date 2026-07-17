// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// BYO chart-workload CONTRACT-LOCK (W5 Path A — Option B), TS half. The Go extractor is the wire's
// source (the CHART_SCAN runner emits []types.ChartWorkload, frozen into
// test/e2e/fixtures/chart_workloads.json by chart_workloads_contract_pure_test.go). This proves the
// console parses that exact wire against its zod + JSONB interfaces — so a Go-side shape change that
// slips past the Go golden reds here too, and the console can never silently mis-read a described
// workload. Regenerate the fixture (Go side): UPDATE_FIXTURES=1 go test ./ -run ChartWorkloadsContract
// (in test/e2e, GOWORK=off).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chartWorkloadWireArraySchema } from "@/lib/validations/chart-workloads";
import type { ChartWorkloadRendered } from "@/types/jsonb.types";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/console/tests/e2e-fixtures → repo root is four levels up.
const FIXTURE = join(__dirname, "../../../../test/e2e/fixtures/chart_workloads.json");

describe("BYO chart-workload contract (W5 Path A)", () => {
	it("the Go extractor's wire fixture parses against the console zod", () => {
		const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
		const parsed = chartWorkloadWireArraySchema.parse(raw);
		expect(parsed).toHaveLength(2);

		const [web, worker] = parsed;
		// web — the maximal Deployment.
		expect(web.name).toBe("web");
		expect(web.workload_kind).toBe("deployment");
		expect(web.rendered.image).toBe("ghcr.io/acme/web:1.2.3");
		expect(web.rendered.ports.map((p) => p.container_port)).toEqual([8080, 9090]);
		expect(web.rendered.env_keys).toEqual(["LOG_LEVEL", "DB_URL"]);
		expect(web.rendered.replicas).toBe(3);
		expect(web.rendered.resources?.limits.cpu).toBe("1");

		// worker — the minimal Job: no resources/replicas, empty ports/env.
		expect(worker.workload_kind).toBe("job");
		expect(worker.rendered.replicas).toBeUndefined();
		expect(worker.rendered.resources).toBeUndefined();
		expect(worker.rendered.ports).toEqual([]);
		expect(worker.rendered.env_keys).toEqual([]);
	});

	it("the parsed rendered shape satisfies the ChartWorkloadRendered interface", () => {
		const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
		const parsed = chartWorkloadWireArraySchema.parse(raw);
		// Type-level: assignability proves the zod output matches the persisted JSONB interface.
		const rendered: ChartWorkloadRendered = parsed[0].rendered;
		expect(rendered.image).toBeTruthy();
	});
});
