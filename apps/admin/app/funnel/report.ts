// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The staff app's read of the console funnel (REL-L12, #6913). The console computes it
// (apps/console/lib/queries/funnel.ts) and answers it on /api/internal/platform/funnel; this file is
// the consumer's half of that wire contract. It is strict on purpose: the page must only ever render
// days, stages, clouds and counts, so a body carrying any other field — an identifier added upstream
// by mistake — fails the parse and the page shows an error instead of the field.
//
// A sibling app may not import console code (apps/admin/eslint.config.mjs), so the stage list is
// restated here. A stage the console adds without this list following fails the parse loudly; that
// is the intended failure, not drift.

import { z } from "zod";

/** The funnel stages, in funnel order, with the label the page shows for each. */
export const STAGES = [
	{ key: "signed_up", label: "Signed up" },
	{ key: "organization_created", label: "Organization created" },
	{ key: "cloud_connected", label: "Cloud connected" },
	{ key: "project_created", label: "Project created" },
	{ key: "first_deploy", label: "First deploy" },
	{ key: "subscribed", label: "First payment" },
] as const;

const STAGE_KEYS = [
	"signed_up",
	"organization_created",
	"cloud_connected",
	"project_created",
	"first_deploy",
	"subscribed",
] as const;

/** One funnel stage key. */
export type FunnelStage = (typeof STAGE_KEYS)[number];

/** The window lengths the page offers, in days. The console accepts 1..90. */
export const WINDOW_CHOICES = [7, 30, 90] as const;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const stage = z.enum(STAGE_KEYS);
// A cloud is a short lowercase provider key; null when the stage has no cloud or the row named none.
const cloud = z.string().regex(/^[a-z]{2,20}$/).nullable();
const count = z.number().int().nonnegative();

/** The funnel report as the console sends it — aggregate counts only, strict at every level. */
export const funnelReportSchema = z
	.object({
		from: day,
		to: day,
		days: z.array(day),
		cells: z.array(z.object({ day, stage, cloud, count }).strict()),
		totals: z.array(z.object({ stage, cloud, count }).strict()),
	})
	.strict();

/** The validated funnel report. */
export type FunnelReport = z.infer<typeof funnelReportSchema>;

/** Display names for the provider keys the console uses; an unknown key shows as itself. */
const CLOUD_LABELS: Record<string, string> = {
	aws: "AWS",
	gcp: "GCP",
	azure: "Azure",
	hetzner: "Hetzner",
	alibaba: "Alibaba",
	digitalocean: "DigitalOcean",
	civo: "Civo",
};

/** The label for a cloud column; `null` is the column for counts no cloud applies to. */
export function cloudLabel(key: string | null): string {
	if (key === null) return "No cloud";
	return CLOUD_LABELS[key] ?? key;
}

/** Parses the window choice from `?days=`, falling back to 30 for anything not offered. */
export function parseWindow(raw: string | undefined): (typeof WINDOW_CHOICES)[number] {
	const n = Number(raw);
	return WINDOW_CHOICES.find((c) => c === n) ?? 30;
}

/** A stage × cloud matrix of window totals, with the clouds that appear in it (null first). */
export function totalsMatrix(report: FunnelReport): {
	clouds: (string | null)[];
	get: (stage: FunnelStage, cloud: string | null) => number;
	stageTotal: (stage: FunnelStage) => number;
} {
	const map = new Map<string, number>();
	const clouds = new Set<string | null>();
	for (const t of report.totals) {
		map.set(`${t.stage}|${t.cloud ?? ""}`, t.count);
		clouds.add(t.cloud);
	}
	const ordered = [...clouds].sort((a, b) =>
		a === null ? -1 : b === null ? 1 : a.localeCompare(b),
	);
	return {
		clouds: ordered,
		get: (s, c) => map.get(`${s}|${c ?? ""}`) ?? 0,
		stageTotal: (s) =>
			report.totals.filter((t) => t.stage === s).reduce((sum, t) => sum + t.count, 0),
	};
}

/** Per-day counts for each stage summed across clouds, newest day first. */
export function dailyRows(
	report: FunnelReport,
): { day: string; counts: Record<FunnelStage, number> }[] {
	const byDay = new Map<string, Record<FunnelStage, number>>();
	for (const d of report.days) {
		byDay.set(d, {
			signed_up: 0,
			organization_created: 0,
			cloud_connected: 0,
			project_created: 0,
			first_deploy: 0,
			subscribed: 0,
		});
	}
	for (const c of report.cells) {
		const row = byDay.get(c.day);
		if (row) row[c.stage] += c.count;
	}
	return [...byDay.entries()]
		.map(([d, counts]) => ({ day: d, counts }))
		.sort((a, b) => b.day.localeCompare(a.day));
}
