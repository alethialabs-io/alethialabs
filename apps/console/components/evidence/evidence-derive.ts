// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure derivations behind the Evidence surface — no JSX, no React, so the meter/triage/
// grouping/sort math is unit-testable in isolation. The client component holds UI state and
// feeds these; the design's visual layer maps the returned `tone`/`iconKey` to grayscale
// Tailwind tokens + lucide icons.

import { formatDistanceToNow } from "date-fns";
import type {
	EvidenceEnvRow,
	EvidenceSummary,
	EvidenceWaiver,
	OrgEvidence,
} from "@/lib/queries/evidence";

// Re-exported so the Evidence components import the row type alongside the derive helpers.
export type { EvidenceEnvRow } from "@/lib/queries/evidence";

/** Grayscale-first semantic tone. `bad` is the only one the UI paints with `destructive`. */
export type Tone = "good" | "warn" | "bad" | "unknown" | "muted";

/** An environment is "stale" once its freshest proof is older than this (days). */
export const STALE_DAYS = 7;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

/** Relative-time label from an ISO timestamp (e.g. "3 hours ago"), or "—" when absent. */
export function relTime(iso: string | null): string {
	if (!iso) return "—";
	return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

/** The freshest proof timestamp on a row (max of verify / drift / security), or null. */
export function lastChecked(row: EvidenceEnvRow): string | null {
	const times = [
		row.verify?.evaluatedAt,
		row.drift?.scannedAt,
		row.security?.scannedAt,
	].filter((t): t is string => Boolean(t));
	if (times.length === 0) return null;
	return times.reduce((a, b) => (a > b ? a : b));
}

/** True when the row's freshest proof is older than the day-2 staleness window. */
export function isStale(row: EvidenceEnvRow): boolean {
	const t = lastChecked(row);
	if (!t) return true;
	return Date.now() - new Date(t).getTime() > STALE_MS;
}

// ── Distribution meters ──────────────────────────────────────────────────────

export interface MeterSegment {
	key: string;
	label: string;
	count: number;
	tone: Tone;
}

export interface Meter {
	key: "verify" | "drift" | "security";
	title: string;
	scope: string;
	headNum: number;
	headLabel: string;
	segments: MeterSegment[];
}

/** The three headline distribution meters (verify / drift / security) from the summary + rows. */
export function buildMeters(ev: OrgEvidence): Meter[] {
	const s = ev.summary;
	const sec = sumSeverities(ev.rows);
	return [
		{
			key: "verify",
			title: "Verify",
			scope: `${s.environments} env`,
			headNum: s.verified,
			headLabel: "verified",
			segments: [
				{ key: "pass", label: "Verified", count: s.verified, tone: "good" },
				{ key: "warn", label: "Warnings", count: s.warning, tone: "warn" },
				{ key: "fail", label: "Failing", count: s.failing, tone: "bad" },
				{
					key: "not_evaluable",
					label: "Not evaluable",
					count: s.notEvaluable,
					tone: "unknown",
				},
				{
					key: "unverified",
					label: "Not verified",
					count: s.unverified,
					tone: "muted",
				},
			],
		},
		{
			key: "drift",
			title: "Drift",
			scope: `${s.environments} env`,
			headNum: s.inSync,
			headLabel: "in sync",
			segments: [
				{ key: "inSync", label: "In sync", count: s.inSync, tone: "good" },
				{ key: "drifted", label: "Drifted", count: s.drifted, tone: "bad" },
				{
					key: "driftUnknown",
					label: "Not scanned",
					count: s.driftUnknown,
					tone: "muted",
				},
			],
		},
		{
			key: "security",
			title: "Security",
			scope: `${s.environments - s.securityUnknown} scanned`,
			headNum: s.criticalHighVulns,
			headLabel: "crit + high",
			segments: [
				{ key: "critical", label: "Critical", count: sec.critical, tone: "bad" },
				{ key: "high", label: "High", count: sec.high, tone: "warn" },
				{ key: "medium", label: "Medium", count: sec.medium, tone: "unknown" },
				{ key: "low", label: "Low", count: sec.low, tone: "muted" },
			],
		},
	];
}

/** Σ each vulnerability severity across scanned environments. */
export function sumSeverities(rows: EvidenceEnvRow[]): {
	critical: number;
	high: number;
	medium: number;
	low: number;
} {
	return rows.reduce(
		(acc, r) => {
			if (r.security?.scanned) {
				acc.critical += r.security.critical;
				acc.high += r.security.high;
				acc.medium += r.security.medium;
				acc.low += r.security.low;
			}
			return acc;
		},
		{ critical: 0, high: 0, medium: 0, low: 0 },
	);
}

// ── Triage clusters ──────────────────────────────────────────────────────────

export type TriageKey =
	| "all"
	| "failing"
	| "drifted"
	| "vulns"
	| "waived"
	| "unverified"
	| "notEvaluable"
	| "driftUnknown"
	| "securityUnknown";

export interface TriageItem {
	key: TriageKey;
	label: string;
	value: number;
	tone: Tone;
}

export interface TriageCluster {
	key: "attention" | "gaps";
	label: string;
	items: TriageItem[];
}

/** "project|env" keys of the environments named by an active waiver (for the `waived` filter). */
function waivedEnvSet(waivers: EvidenceWaiver[]): Set<string> {
	const set = new Set<string>();
	for (const w of waivers) {
		if (w.active && w.projectName && w.environmentName) {
			set.add(`${w.projectName}|${w.environmentName}`);
		}
	}
	return set;
}

/** The two triage clusters — "needs attention" (destructive) and "coverage gaps" (unknown). */
export function buildTriage(summary: EvidenceSummary): TriageCluster[] {
	return [
		{
			key: "attention",
			label: "Needs attention",
			items: [
				{ key: "failing", label: "Failing", value: summary.failing, tone: "bad" },
				{ key: "drifted", label: "Drifted", value: summary.drifted, tone: "bad" },
				{
					key: "vulns",
					label: "Crit / high vulns",
					value: summary.criticalHighVulns,
					tone: "bad",
				},
				{
					key: "waived",
					label: "Active waivers",
					value: summary.activeWaivers,
					tone: "warn",
				},
			],
		},
		{
			key: "gaps",
			label: "Coverage gaps",
			items: [
				{
					key: "unverified",
					label: "Not verified",
					value: summary.unverified,
					tone: "unknown",
				},
				{
					key: "notEvaluable",
					label: "Not evaluable",
					value: summary.notEvaluable,
					tone: "unknown",
				},
				{
					key: "driftUnknown",
					label: "Drift unknown",
					value: summary.driftUnknown,
					tone: "unknown",
				},
				{
					key: "securityUnknown",
					label: "Unscanned",
					value: summary.securityUnknown,
					tone: "unknown",
				},
			],
		},
	];
}

/** Whether a row satisfies a triage filter (`all` matches everything). */
export function matchesTriage(
	row: EvidenceEnvRow,
	key: TriageKey,
	waived: Set<string>,
): boolean {
	switch (key) {
		case "all":
			return true;
		case "failing":
			return row.verify?.verdict === "fail";
		case "drifted":
			return Boolean(row.drift && !row.drift.inSync);
		case "vulns":
			return Boolean(
				row.security?.scanned &&
					row.security.critical + row.security.high > 0,
			);
		case "waived":
			return waived.has(`${row.projectName}|${row.environmentName}`);
		case "unverified":
			return !row.verify;
		case "notEvaluable":
			return row.verify?.verdict === "not_evaluable";
		case "driftUnknown":
			return !row.drift;
		case "securityUnknown":
			return !row.security?.scanned;
	}
}

// ── Filter → group → sort pipeline ───────────────────────────────────────────

export type GroupMode = "triage" | "project" | "stage";
export type SortKey = "worst" | "stale" | "name";

export interface RowGroup {
	key: string;
	label: string;
	iconKey: string;
	tone: Tone;
	rows: EvidenceEnvRow[];
}

export interface DeriveOptions {
	search: string;
	stage: string; // "all" | stage
	triage: TriageKey;
	group: GroupMode;
	sort: SortKey;
}

/** Worst-first severity score for a row (higher = more urgent). Deterministic. */
export function rowScore(row: EvidenceEnvRow): number {
	let n = 0;
	switch (row.verify?.verdict) {
		case "fail":
			n += 1000;
			break;
		case "warn":
			n += 200;
			break;
		case "not_evaluable":
			n += 90;
			break;
		case "pass":
			break;
		default:
			n += 80; // unverified
	}
	if (row.drift) {
		if (!row.drift.inSync) n += 600 + row.drift.drifted;
	} else {
		n += 60; // drift unknown
	}
	if (row.security?.scanned) {
		n += row.security.critical * 120 + row.security.high * 40;
	} else {
		n += 60; // security unknown
	}
	return n;
}

const STAGE_ORDER: Record<string, number> = {
	production: 0,
	staging: 1,
	development: 2,
};

/** Filters rows by search + stage + triage, buckets them into groups, and sorts each group. */
export function deriveGroups(
	ev: OrgEvidence,
	opts: DeriveOptions,
): { groups: RowGroup[]; resultCount: number } {
	const waived = waivedEnvSet(ev.waivers);
	const q = opts.search.trim().toLowerCase();
	const filtered = ev.rows.filter((r) => {
		if (opts.stage !== "all" && r.stage !== opts.stage) return false;
		if (!matchesTriage(r, opts.triage, waived)) return false;
		if (!q) return true;
		return [r.projectName, r.environmentName, r.region, r.provider ?? ""]
			.join(" ")
			.toLowerCase()
			.includes(q);
	});

	const buckets = new Map<string, RowGroup>();
	const ensure = (
		key: string,
		label: string,
		iconKey: string,
		tone: Tone,
	): RowGroup => {
		let g = buckets.get(key);
		if (!g) {
			g = { key, label, iconKey, tone, rows: [] };
			buckets.set(key, g);
		}
		return g;
	};

	for (const r of filtered) {
		if (opts.group === "project") {
			ensure(r.projectId, r.projectName, "folder", "muted").rows.push(r);
		} else if (opts.group === "stage") {
			ensure(r.stage, stageLabel(r.stage), "layers", "muted").rows.push(r);
		} else {
			const b = triageBucket(r);
			ensure(b.key, b.label, b.iconKey, b.tone).rows.push(r);
		}
	}

	const groups = [...buckets.values()];
	// Order the groups themselves.
	groups.sort((a, b) => {
		if (opts.group === "stage")
			return (STAGE_ORDER[a.key] ?? 9) - (STAGE_ORDER[b.key] ?? 9);
		if (opts.group === "triage")
			return TRIAGE_BUCKET_ORDER[a.key] - TRIAGE_BUCKET_ORDER[b.key];
		return a.label.localeCompare(b.label);
	});
	// Sort rows within each group.
	for (const g of groups) sortRows(g.rows, opts.sort);

	return { groups, resultCount: filtered.length };
}

const TRIAGE_BUCKET_ORDER: Record<string, number> = {
	attention: 0,
	gaps: 1,
	healthy: 2,
};

/** Which triage bucket a row falls in when grouping by triage. */
function triageBucket(row: EvidenceEnvRow): {
	key: string;
	label: string;
	iconKey: string;
	tone: Tone;
} {
	const attention =
		row.verify?.verdict === "fail" ||
		Boolean(row.drift && !row.drift.inSync) ||
		Boolean(
			row.security?.scanned && row.security.critical + row.security.high > 0,
		);
	if (attention)
		return {
			key: "attention",
			label: "Needs attention",
			iconKey: "triangle-alert",
			tone: "bad",
		};
	const gaps =
		!row.verify ||
		row.verify.verdict === "not_evaluable" ||
		!row.drift ||
		!row.security?.scanned;
	if (gaps)
		return {
			key: "gaps",
			label: "Coverage gaps",
			iconKey: "shield-question",
			tone: "unknown",
		};
	return {
		key: "healthy",
		label: "Healthy",
		iconKey: "shield-check",
		tone: "good",
	};
}

/** Sorts a group's rows in place by the chosen key. */
function sortRows(rows: EvidenceEnvRow[], sort: SortKey): void {
	if (sort === "worst") {
		rows.sort((a, b) => rowScore(b) - rowScore(a));
	} else if (sort === "stale") {
		rows.sort((a, b) => staleRank(a) - staleRank(b));
	} else {
		rows.sort(
			(a, b) =>
				a.projectName.localeCompare(b.projectName) ||
				a.environmentName.localeCompare(b.environmentName),
		);
	}
}

/** Ascending rank for "stale" sort — never-checked first, then oldest-checked first. */
function staleRank(row: EvidenceEnvRow): number {
	const t = lastChecked(row);
	return t ? new Date(t).getTime() : 0;
}

/** Human stage label (capitalized). */
export function stageLabel(stage: string): string {
	return stage.charAt(0).toUpperCase() + stage.slice(1);
}
