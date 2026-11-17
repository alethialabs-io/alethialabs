// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The billing and usage pages' read states (#6127, ADR 0005 §10 R11, RUBRIC B4). A section's read
// ends in one of FOUR renders, and they must not be confused with each other:
//   · pending   — a skeleton in the section's final shape (only when nothing was prefetched);
//   · refused   — an EXPECTED refusal from the read router: FORBIDDEN (this viewer may not see it)
//                 or ENTITLEMENT_REQUIRED (hosted billing / an organization is required) — its own
//                 calm note, no retry, because asking again gets the same answer;
//   · failed    — `RegionError` with a retry;
//   · data      — including an EMPTY list, which is a fact about the account.
// No "use client": the component is presentational and renders from either side.

import { ORPCError } from "@orpc/client";
import { RegionRefusal as SharedRegionRefusal } from "@/components/errors/region-refusal";

/** The expected refusals a billing/usage read can answer with. */
export type Refusal = "forbidden" | "plan" | "not-found";

/** The read router's typed refusal behind a failed read, or null for a real failure. */
export function refusalOf(error: unknown): Refusal | null {
	if (!(error instanceof ORPCError) || !error.defined) return null;
	if (error.code === "FORBIDDEN") return "forbidden";
	if (error.code === "ENTITLEMENT_REQUIRED") return "plan";
	if (error.code === "NOT_FOUND") return "not-found";
	return null;
}

/**
 * The sections' `retry`: once for a failure, never for an expected refusal — a refusal answers the
 * same the second time, so retrying it only delays the refused render.
 */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
	return refusalOf(error) === null && failureCount < 1;
}

const COPY: Record<Refusal, { title: string; description: string }> = {
	forbidden: {
		title: "Billing admins only",
		description: "You need the billing permission in this organization to see this.",
	},
	plan: {
		title: "Not available here",
		description: "This needs hosted billing and an organization.",
	},
	"not-found": {
		title: "Not found",
		description: "This no longer exists, or it isn't in this organization.",
	},
};

/**
 * The refused render of ONE billing or usage section: the console's one refused render
 * (`components/errors/region-refusal.tsx`) with billing's own lines, because what decides a billing
 * read is the billing permission and hosted billing, not the viewer's role alone. The look, the
 * lock and `data-state="refused"` are the shared component's.
 */
export function RegionRefusal({
	refusal,
	title,
	description,
	className,
}: {
	refusal: Refusal;
	/** Overrides the refusal's default title, in the section's own terms. */
	title?: string;
	/** Overrides the refusal's default line. */
	description?: string;
	className?: string;
}) {
	const copy = COPY[refusal];
	return (
		<SharedRegionRefusal
			refusal={refusal}
			title={title ?? copy.title}
			description={description ?? copy.description}
			className={className}
		/>
	);
}
