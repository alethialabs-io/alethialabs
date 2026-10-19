// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The jobs page's read input, shared by the browser (which builds it) and the procedure (which
// validates it). Plain zod, no server imports, so a client component may import it.

import { z } from "zod";

/** The quick-range presets the jobs page offers (`@repo/ui/range` RANGE_PRESETS ids). */
export const JOBS_RANGE_PRESETS = ["7d", "14d", "30d", "3mo", "12mo"] as const;

/**
 * A now-relative range travels as its PRESET, not as resolved timestamps (#6113). Resolving
 * "last 12 months" on the client produced a key with millisecond bounds, so the server's prefetch
 * key and the client's key never matched and every first paint refetched (F004's sibling). The
 * server resolves the preset at read time; an explicit range keeps its ISO bounds.
 */
export const jobsRangeInput = z.union([
	z.object({ preset: z.enum(JOBS_RANGE_PRESETS) }),
	z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
]);

const ids = z.array(z.string().min(1).max(200)).max(200).optional();

/** One page of the jobs list: filters + range. Normalized (sorted, empty → absent) by the caller. */
export const jobsPageInput = z.object({
	range: jobsRangeInput,
	search: z.string().max(200).optional(),
	authors: ids,
	envs: ids,
	projects: ids,
	statuses: ids,
	types: ids,
});

/** The validated shape of {@link jobsPageInput}. */
export type JobsPageInput = z.infer<typeof jobsPageInput>;

/** The range the jobs page opens on. */
export const JOBS_DEFAULT_PRESET = "12mo" satisfies (typeof JOBS_RANGE_PRESETS)[number];

/** The page's range: a quick-range preset, or explicit bounds from the date picker. */
export type JobsRange = z.infer<typeof jobsRangeInput>;

/** The filter part of the page's query, as `normalizeJobsQuery` produces it (bounds ignored). */
export interface JobsFilterQuery {
	search?: string;
	authors?: string[];
	envs?: string[];
	projects?: string[];
	statuses?: string[];
	types?: string[];
}

/**
 * The read input for a normalized filter query and a range. Built identically by the server
 * prefetch and the client, so both ask for the SAME key — the property first paint depends on.
 */
export function jobsPageInputFrom(filters: JobsFilterQuery, range: JobsRange): JobsPageInput {
	const { search, authors, envs, projects, statuses, types } = filters;
	return {
		range,
		...(search ? { search } : {}),
		...(authors ? { authors } : {}),
		...(envs ? { envs } : {}),
		...(projects ? { projects } : {}),
		...(statuses ? { statuses } : {}),
		...(types ? { types } : {}),
	};
}

/** The preset id for a quick-range label, or undefined for a custom range. */
export function jobsPresetForLabel(label: string, presets: ReadonlyArray<{ id: string; label: string }>): JobsRange | undefined {
	const preset = presets.find((p) => p.label === label)?.id;
	const parsed = jobsRangeInput.safeParse({ preset });
	return parsed.success ? parsed.data : undefined;
}
