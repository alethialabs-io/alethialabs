// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Validators for BYO chart workloads (W5 Path A — Option B). Two layers:
//   1. the runner → console extraction WIRE (execution_metadata.chart_workloads) the CHART_SCAN job
//      emits per rendered workload — contract-locked against the Go emitter
//      (test/e2e/fixtures/chart_workloads.json);
//   2. the full project_chart_workloads insert (persist), which adds the user overlay columns.
// The env/port/resource/binding sub-shapes are reused verbatim from the W1 service form so a chart
// workload and a first-class service speak the same vocabulary.

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { projectChartWorkloads } from "@/lib/db/schema";
import {
	serviceBindingSchema,
	serviceEnvSchema,
	servicePortSchema,
	serviceResourcesSchema,
} from "./project-form.schema";

/** Kind of workload a chart renders (mirror of the chart_workload_kind pg enum). */
export const chartWorkloadKindSchema = z.enum([
	"deployment",
	"statefulset",
	"daemonset",
	"cronjob",
	"job",
]);

/**
 * The immutable rendered description (mirror of types/jsonb.types.ts `ChartWorkloadRendered` and the
 * Go `types.ChartWorkloadRendered`). `env_keys` is KEY NAMES only — a description never carries a
 * rendered secret value.
 */
export const chartWorkloadRenderedSchema = z.object({
	image: z.string(),
	ports: z.array(servicePortSchema).default([]),
	env_keys: z.array(z.string()).default([]),
	resources: serviceResourcesSchema.optional(),
	replicas: z.number().int().optional(),
});

/**
 * One entry of the runner → console extraction wire. Overlay columns (bindings/config/value_paths)
 * are console-side and NOT on the wire; the runner emits only what it can read off the render.
 */
export const chartWorkloadWireSchema = z.object({
	name: z.string().min(1),
	workload_kind: chartWorkloadKindSchema,
	rendered: chartWorkloadRenderedSchema,
});
export const chartWorkloadWireArraySchema = z.array(chartWorkloadWireSchema);
export type ChartWorkloadWire = z.infer<typeof chartWorkloadWireSchema>;

/** The user's editable overlay (v1: replicas + env), written back to chart values on deploy (Lane 2). */
export const chartWorkloadConfigSchema = z.object({
	replicas: z.number().int().min(0).optional(),
	env: z.array(serviceEnvSchema).optional(),
});

/**
 * Full project_chart_workloads insert. The overlay columns default like their DB columns so a
 * freshly-described workload (no user edits yet) parses.
 */
export const chartWorkloadInsert = createInsertSchema(projectChartWorkloads, {
	workload_kind: chartWorkloadKindSchema,
	rendered: chartWorkloadRenderedSchema,
	bindings: z.array(serviceBindingSchema).default([]),
	config: chartWorkloadConfigSchema.default({}),
	value_paths: z.record(z.string(), z.string()).default({}),
});
