"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The tool→widget registry: the single client-side SSOT mapping a read tool's name to
// how its output renders (body component), how big it lands on the bento grid, and its
// refresh policy. The transcript's ToolView and the grid's widget cards both consume
// this, so the two surfaces can never drift. Every Body re-validates the raw output
// with the same zod schema it was pinned with (cast-free) and renders nothing on a
// mismatch — the caller falls back to its generic treatment.

import type { ComponentType } from "react";
import { z } from "zod";
import type { Artifact, ArtifactTab } from "@/lib/stores/use-artifact-store";
import type { WidgetKind } from "@/types/jsonb.types";
import {
	ClustersTable,
	ConnectorsTable,
	JobsTable,
	ProjectsTable,
	RunnersTable,
} from "./bodies/tables";
import { KeyValueList } from "./bodies/blocks";

const str = z.string().nullish();

const projectsOut = z.object({
	projects: z.array(
		z.object({ id: z.string(), name: str, environment: str, region: str, status: str }),
	),
});
const jobsOut = z.object({
	jobs: z.array(
		z.object({ id: z.string(), type: str, project: str, provider: str, status: str }),
	),
});
const clustersOut = z.object({
	clusters: z.array(
		z.object({ id: z.string(), name: str, region: str, provider: str, status: str }),
	),
});
const connectorsOut = z.object({
	connectors: z.array(
		z.object({
			slug: z.string(),
			name: str,
			category: str,
			status: str,
			connected: z.boolean().nullish(),
		}),
	),
});
const runnersOut = z.object({
	runners: z.array(
		z.object({
			id: z.string(),
			name: str,
			operator: str,
			status: str,
			online: z.boolean().nullish(),
		}),
	),
});
// Anchor fields (always present on the tool's return) are REQUIRED so a foreign
// object never parses as a renderable summary.
const orgUsageOut = z.object({
	plan: z.string().nullable(),
	used_minutes: z.number().nullable(),
	included_minutes: z.number().nullish(),
	overage_minutes: z.number().nullish(),
	overage_cost_usd: z.number().nullish(),
	running_jobs: z.number().nullish(),
	max_concurrent_jobs: z.number().nullish(),
});
const aiUsageOut = z.object({
	tier: z.string().nullable(),
	session_used: z.number().nullable(),
	session_budget: z.number().nullish(),
	weekly_used: z.number().nullish(),
	weekly_budget: z.number().nullish(),
	purchased_balance: z.number().nullish(),
});
const billingOut = z.object({
	plan: z.string().nullable(),
	status: z.string().nullable(),
	seats: z.number().nullish(),
	member_count: z.number().nullish(),
	unit_amount_usd: z.number().nullish(),
	current_period_end: str,
});
const driftOut = z.object({
	status: z.string(),
	in_sync: z.boolean().nullish(),
	drifted: z.number().nullish(),
	scanned_at: str,
});

/** Props every widget body receives: the raw tool output snapshot + panel opener. */
export interface WidgetBodyProps {
	output: unknown;
	/** Optional artifact-panel click-through (transcript passes it; grid may omit). */
	openArtifact?: (artifact: Artifact, tab: ArtifactTab) => void;
}

/** One registry entry: how a tool's result renders + lands on the grid. */
export interface WidgetDef {
	kind: WidgetKind;
	/** Default footprint on the 5-column grid. */
	defaultSize: { colspan: number; rowspan: number };
	/** Default widget title (the marker/card caption). */
	title: string;
	/** Pin-time validation: does this output parse into something renderable? */
	parses: (output: unknown) => boolean;
	/** Marker-line/caption detail for a parsed output (e.g. "7 rows"). */
	detail: (output: unknown) => string | undefined;
	Body: ComponentType<WidgetBodyProps>;
	/** PR 3: live widgets refetch via their source on this cadence. */
	liveByDefault: boolean;
	refreshIntervalMs: number | null;
}

/** "4 rows" / "1 row". */
function rowsDetail(n: number): string {
	return `${n} ${n === 1 ? "row" : "rows"}`;
}

/** Render a `$`-prefixed USD amount (or an em-dash). */
function usd(v: number | null | undefined): string {
	return typeof v === "number" ? `$${v.toFixed(2)}` : "—";
}

/** Projects list body. */
function ProjectsBody({ output, openArtifact }: WidgetBodyProps) {
	const p = projectsOut.safeParse(output);
	if (!p.success) return null;
	return (
		<ProjectsTable
			rows={p.data.projects}
			onRowClick={
				openArtifact ? (id) => openArtifact({ projectId: id }, "config") : undefined
			}
		/>
	);
}

/** Jobs list body. */
function JobsBody({ output, openArtifact }: WidgetBodyProps) {
	const p = jobsOut.safeParse(output);
	if (!p.success) return null;
	return (
		<JobsTable
			rows={p.data.jobs}
			onRowClick={openArtifact ? (id) => openArtifact({ jobId: id }, "logs") : undefined}
		/>
	);
}

/** Clusters list body. */
function ClustersBody({ output }: WidgetBodyProps) {
	const p = clustersOut.safeParse(output);
	return p.success ? <ClustersTable rows={p.data.clusters} /> : null;
}

/** Connectors list body. */
function ConnectorsBody({ output }: WidgetBodyProps) {
	const p = connectorsOut.safeParse(output);
	return p.success ? <ConnectorsTable rows={p.data.connectors} /> : null;
}

/** Runners list body. */
function RunnersBody({ output }: WidgetBodyProps) {
	const p = runnersOut.safeParse(output);
	return p.success ? <RunnersTable rows={p.data.runners} /> : null;
}

/** Runner-minutes usage body (key/value). */
function OrgUsageBody({ output }: WidgetBodyProps) {
	const p = orgUsageOut.safeParse(output);
	if (!p.success) return null;
	const u = p.data;
	return (
		<KeyValueList
			rows={[
				{ label: "Plan", value: u.plan ?? "—" },
				{
					label: "Runner minutes",
					value: `${u.used_minutes ?? 0} / ${u.included_minutes ?? 0}`,
				},
				{ label: "Overage", value: usd(u.overage_cost_usd) },
				{
					label: "Jobs",
					value: `${u.running_jobs ?? 0} running · max ${u.max_concurrent_jobs ?? "—"}`,
				},
			]}
		/>
	);
}

/** AI-usage body (key/value). */
function AiUsageBody({ output }: WidgetBodyProps) {
	const p = aiUsageOut.safeParse(output);
	if (!p.success) return null;
	const a = p.data;
	return (
		<KeyValueList
			rows={[
				{ label: "Tier", value: a.tier ?? "—" },
				{ label: "Session", value: `${a.session_used ?? 0} / ${a.session_budget ?? 0}` },
				{ label: "Week", value: `${a.weekly_used ?? 0} / ${a.weekly_budget ?? 0}` },
				{ label: "Credits", value: `${a.purchased_balance ?? 0}` },
			]}
		/>
	);
}

/** Billing summary body (key/value). */
function BillingBody({ output }: WidgetBodyProps) {
	const p = billingOut.safeParse(output);
	if (!p.success) return null;
	const b = p.data;
	return (
		<KeyValueList
			rows={[
				{ label: "Plan", value: b.plan ?? "—" },
				{ label: "Status", value: b.status ?? "—" },
				{ label: "Seats", value: `${b.member_count ?? 0} / ${b.seats ?? 0}` },
				{ label: "Per seat", value: usd(b.unit_amount_usd) },
			]}
		/>
	);
}

/** Drift posture body (key/value). */
function DriftBody({ output }: WidgetBodyProps) {
	const p = driftOut.safeParse(output);
	if (!p.success) return null;
	const d = p.data;
	return (
		<KeyValueList
			rows={[
				{
					label: "Posture",
					value: d.in_sync === true ? "in sync" : d.in_sync === false ? "drifted" : (d.status ?? "—"),
				},
				{ label: "Drifted resources", value: `${d.drifted ?? 0}` },
				{ label: "Scanned", value: d.scanned_at ?? "—" },
			]}
		/>
	);
}

/**
 * The registry, keyed by tool name (no `tool-` prefix). Tabular reads land 3×2;
 * summaries land 2×2 key/value cards. Refresh cadences take effect in PR 3.
 */
export const WIDGET_REGISTRY: Record<string, WidgetDef> = {
	list_projects: {
		kind: "table",
		defaultSize: { colspan: 3, rowspan: 2 },
		title: "Projects",
		parses: (o) => projectsOut.safeParse(o).success,
		detail: (o) => {
			const p = projectsOut.safeParse(o);
			return p.success ? rowsDetail(p.data.projects.length) : undefined;
		},
		Body: ProjectsBody,
		liveByDefault: false,
		refreshIntervalMs: null,
	},
	list_jobs: {
		kind: "table",
		defaultSize: { colspan: 3, rowspan: 2 },
		title: "Jobs",
		parses: (o) => jobsOut.safeParse(o).success,
		detail: (o) => {
			const p = jobsOut.safeParse(o);
			return p.success ? rowsDetail(p.data.jobs.length) : undefined;
		},
		Body: JobsBody,
		liveByDefault: true,
		refreshIntervalMs: 15_000,
	},
	list_clusters: {
		kind: "table",
		defaultSize: { colspan: 3, rowspan: 2 },
		title: "Clusters",
		parses: (o) => clustersOut.safeParse(o).success,
		detail: (o) => {
			const p = clustersOut.safeParse(o);
			return p.success ? rowsDetail(p.data.clusters.length) : undefined;
		},
		Body: ClustersBody,
		liveByDefault: true,
		refreshIntervalMs: 60_000,
	},
	list_connectors: {
		kind: "table",
		defaultSize: { colspan: 3, rowspan: 2 },
		title: "Connectors",
		parses: (o) => connectorsOut.safeParse(o).success,
		detail: (o) => {
			const p = connectorsOut.safeParse(o);
			return p.success ? rowsDetail(p.data.connectors.length) : undefined;
		},
		Body: ConnectorsBody,
		liveByDefault: true,
		refreshIntervalMs: 60_000,
	},
	list_runners: {
		kind: "table",
		defaultSize: { colspan: 3, rowspan: 2 },
		title: "Runners",
		parses: (o) => runnersOut.safeParse(o).success,
		detail: (o) => {
			const p = runnersOut.safeParse(o);
			return p.success ? rowsDetail(p.data.runners.length) : undefined;
		},
		Body: RunnersBody,
		liveByDefault: true,
		refreshIntervalMs: 60_000,
	},
	get_org_usage: {
		kind: "keyvalue",
		defaultSize: { colspan: 2, rowspan: 2 },
		title: "Runner usage",
		parses: (o) => orgUsageOut.safeParse(o).success,
		detail: () => undefined,
		Body: OrgUsageBody,
		liveByDefault: true,
		refreshIntervalMs: 300_000,
	},
	get_ai_usage: {
		kind: "keyvalue",
		defaultSize: { colspan: 2, rowspan: 2 },
		title: "AI usage",
		parses: (o) => aiUsageOut.safeParse(o).success,
		detail: () => undefined,
		Body: AiUsageBody,
		liveByDefault: true,
		refreshIntervalMs: 300_000,
	},
	get_billing_summary: {
		kind: "keyvalue",
		defaultSize: { colspan: 2, rowspan: 2 },
		title: "Billing",
		parses: (o) => billingOut.safeParse(o).success,
		detail: () => undefined,
		Body: BillingBody,
		liveByDefault: false,
		refreshIntervalMs: null,
	},
	get_drift_posture: {
		kind: "keyvalue",
		defaultSize: { colspan: 2, rowspan: 2 },
		title: "Drift posture",
		parses: (o) => driftOut.safeParse(o).success,
		detail: () => undefined,
		Body: DriftBody,
		liveByDefault: true,
		refreshIntervalMs: 300_000,
	},
};

/** The registry entry for a UIMessage tool part type (`tool-list_jobs` → entry). */
export function widgetDefForPartType(partType: string): WidgetDef | undefined {
	if (!partType.startsWith("tool-")) return undefined;
	return WIDGET_REGISTRY[partType.slice("tool-".length)];
}

/** Default footprint for an exploded dashboard block, by block kind. */
export function blockDefaultSize(kind: string): { colspan: number; rowspan: number } {
	if (kind === "stat") return { colspan: 1, rowspan: 1 };
	if (kind === "line") return { colspan: 2, rowspan: 1 };
	return { colspan: 2, rowspan: 2 };
}
