"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useState } from "react";
import { type DateRange, formatRangeLabel, presetRange, RANGE_PRESETS } from "@repo/ui/range";
import { type JobsRange, jobsPresetForLabel } from "@/lib/rpc/inputs/jobs";
import { USAGE_DEFAULT_RANGE } from "./usage-reads";

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
	const preset = "preset" in USAGE_DEFAULT_RANGE ? USAGE_DEFAULT_RANGE.preset : "";
	return RANGE_PRESETS.find((p) => p.id === preset)?.label ?? "Last 7 days";
}

/**
 * The usage pages' range picker state. A quick-range pick travels as its PRESET (resolved on the
 * server at read time, so the opening window's key is the one the page prefetched); a custom range
 * travels as its ISO bounds.
 */
export function useUsageRange(): UsageRangeState {
	const [range, setRange] = useState<DateRange>(() =>
		presetRange("preset" in USAGE_DEFAULT_RANGE ? USAGE_DEFAULT_RANGE.preset : ""),
	);
	const [label, setLabel] = useState(defaultLabel);
	const [spec, setSpec] = useState<JobsRange>(USAGE_DEFAULT_RANGE);
	return {
		range,
		label,
		spec,
		pickPreset: (next, nextLabel) => {
			setRange(next);
			setLabel(nextLabel);
			setSpec(
				jobsPresetForLabel(nextLabel, RANGE_PRESETS) ?? {
					from: next.from.toISOString(),
					to: next.to.toISOString(),
				},
			);
		},
		pickRange: (next) => {
			setRange(next);
			setLabel(formatRangeLabel(next));
			setSpec({ from: next.from.toISOString(), to: next.to.toISOString() });
		},
	};
}
