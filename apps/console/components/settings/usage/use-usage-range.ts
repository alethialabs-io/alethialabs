"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
	type DateRange,
	DEFAULT_PRESET,
	formatRangeLabel,
	presetRange,
	RANGE_PRESETS,
} from "@repo/ui/range";
import { rangeFromPick, rangeWindowValue } from "@/lib/query/range-filter";
import {
	hrefWithParamPatch,
	type ParamPatch,
	RANGE_PARAM,
	rangeFromUrl,
	rangePatch,
} from "@/lib/query/view-url-params";
import type { JobsRange } from "@/lib/rpc/inputs/jobs";
import {
	METRIC_PARAM,
	metricFromUrl,
	USAGE_DEFAULT_METRIC,
	type UsageMetric,
	usageRangeSpec,
} from "./usage-reads";

/** The over-time section's window, in the three forms its three consumers need. */
export interface UsageRangeState {
	/** What the pickers render. */
	range: DateRange;
	/** What the pickers' trigger and the card's caption say ("Last 7 days"). */
	label: string;
	/** What the READ asks for: the preset while one is picked, explicit bounds otherwise. */
	spec: JobsRange;
	/** The quick-range picker's handler. */
	pickPreset: (range: DateRange, label: string) => void;
	/** The date picker's handler. */
	pickRange: (range: DateRange) => void;
}

/** The label of the default preset. */
function defaultLabel(): string {
	return RANGE_PRESETS.find((p) => p.id === DEFAULT_PRESET)?.label ?? "Last 7 days";
}

/**
 * Applies a param patch to the address bar in place — `history.replaceState`, not a router
 * navigation, so a pick does not re-render the server route; Next keeps `useSearchParams` in step
 * with the native call (the evidence drawer does the same).
 */
function patchUrl(patch: ParamPatch): void {
	window.history.replaceState(
		null,
		"",
		hrefWithParamPatch(window.location.pathname, window.location.search, patch),
	);
}

/**
 * The patch for a range value. The default preset removes the param, so the page's own default
 * link stays bare and its read key stays the one the route prefetched for a bare link.
 */
function usageRangePatch(value: string): ParamPatch {
	return value === DEFAULT_PRESET ? rangePatch("") : rangePatch(value);
}

/**
 * The usage pages' range picker state, kept in the URL (`?range=`, R6 C-32) so a link, a refresh or
 * Back reopens the chart on the window that was picked. A quick-range pick travels as its PRESET
 * (resolved on the server at read time, so the opening window's key is the one the page prefetched);
 * a custom range travels as its ISO bounds.
 */
export function useUsageRange(): UsageRangeState {
	const searchParams = useSearchParams();
	const raw = searchParams.get(RANGE_PARAM) ?? "";
	// The instant a preset is drawn against, resolved once: re-resolving per render would move the
	// pickers' value on every render.
	const [now] = useState(() => new Date());
	const choice = useMemo(() => rangeFromUrl({ get: () => raw }), [raw]);
	const range = useMemo<DateRange>(
		() =>
			choice.kind === "window"
				? { from: new Date(choice.from), to: new Date(choice.to) }
				: presetRange(choice.kind === "preset" ? choice.preset : DEFAULT_PRESET, now),
		[choice, now],
	);
	const label =
		choice.kind === "window"
			? formatRangeLabel(range)
			: choice.kind === "preset"
				? (RANGE_PRESETS.find((p) => p.id === choice.preset)?.label ?? defaultLabel())
				: defaultLabel();
	const spec = useMemo(() => usageRangeSpec(choice), [choice]);
	return {
		range,
		label,
		spec,
		pickPreset: (next, nextLabel) => patchUrl(usageRangePatch(rangeFromPick(next, nextLabel))),
		pickRange: (next) => patchUrl(usageRangePatch(rangeWindowValue(next))),
	};
}

/**
 * The over-time chart's metric, kept in the URL (`?metric=`, R6 C-32). The default metric removes
 * the param.
 */
export function useUsageMetric(): [UsageMetric, (next: UsageMetric) => void] {
	const searchParams = useSearchParams();
	const metric = metricFromUrl(searchParams);
	const setMetric = (next: UsageMetric) =>
		patchUrl({ [METRIC_PARAM]: next === USAGE_DEFAULT_METRIC ? null : next });
	return [metric, setMetric];
}
