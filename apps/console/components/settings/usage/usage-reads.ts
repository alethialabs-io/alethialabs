// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The usage pages' read inputs (#6127, ADR 0005 D1). No "use client" and no server imports: the RSC
// pages build their prefetch keys from this module and the panels build their reads from it, so the
// key the server fills and the key the browser asks for on first paint are one value.
//
// The over-time window and metric are URL state (R6 C-32): `?range=` decoded by the shared view-param
// codec (lib/query/view-url-params.ts, the `range` filter value's grammar) and `?metric=`. A link, a
// refresh or Back reopens the chart on what was picked, and the route prefetches that window.

import type { Query } from "@tanstack/react-query";
import { DEFAULT_PRESET } from "@repo/ui/range";
import { type JobsRange, jobsRangeInput } from "@/lib/rpc/inputs/jobs";
import type { ParamReader } from "@/lib/query/filter-url-codec";
import type { RangeFilter } from "@/lib/query/range-filter";

/**
 * The window both usage pages open on: the default quick-range PRESET, not resolved bounds. A
 * resolved "last 7 days" carries the millisecond the browser computed it, so the server's prefetch
 * key and the client's key would never match and every first paint would refetch (ADR 0005 §10).
 */
export const USAGE_DEFAULT_RANGE: JobsRange = jobsRangeInput.parse({ preset: DEFAULT_PRESET });

/**
 * What the over-time read is asked for a decoded `?range=`: the preset to resolve, explicit bounds,
 * or {@link USAGE_DEFAULT_RANGE} when the link names none (or one that does not decode).
 */
export function usageRangeSpec(choice: RangeFilter): JobsRange {
	if (choice.kind === "preset") return { preset: choice.preset };
	if (choice.kind === "window") return { from: choice.from, to: choice.to };
	return USAGE_DEFAULT_RANGE;
}

/** The three over-time metrics, in tab order. One list, so the org and project tabs cannot drift. */
const USAGE_METRICS = ["runnerMinutes", "jobs", "aiCredits"] as const;

/** One over-time metric. */
export type UsageMetric = (typeof USAGE_METRICS)[number];

/** The metric the chart opens on, and the one an absent `?metric=` means. */
export const USAGE_DEFAULT_METRIC: UsageMetric = "runnerMinutes";

/** The param naming the over-time chart's metric. */
export const METRIC_PARAM = "metric";

/** Type guard: a string is one of {@link USAGE_METRICS}. */
function isUsageMetric(value: string | null): value is UsageMetric {
	return USAGE_METRICS.some((m) => m === value);
}

/** The metric the URL names; absent or unrecognised is the default, never an error. */
export function metricFromUrl(params: ParamReader): UsageMetric {
	const raw = params.get(METRIC_PARAM);
	return isUsageMetric(raw) ? raw : USAGE_DEFAULT_METRIC;
}

/**
 * Whether a cached query is one of the usage pages' own reads (`usage.*`, and `billing.*`, whose
 * summary and live AI prices the org page reads), and settled — the routes' `dehydrate` filter
 * (R6 C-34). The server QueryClient is shared with the `[org]` layout, which hands over the shell's
 * reads through its own boundary; without the filter the page serialized them a second time.
 */
export function isUsageRead(query: Pick<Query, "queryKey" | "state">): boolean {
	const [path] = query.queryKey;
	return (
		query.state.status === "success" &&
		Array.isArray(path) &&
		(path[0] === "usage" || path[0] === "billing")
	);
}
