// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": presentational, so the case route's `not-found.tsx` (a server-or-client boundary)
// and the case-detail region (a case that went away while it was open) can both render from here.

import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { SearchX } from "lucide-react";
import Link from "next/link";
import { globalHref } from "@/lib/routing";

/**
 * The one wording of "this case is not there" (G-25). Non-leaky: a case that never existed and a
 * case in another organization read the same.
 */
export const CASE_NOT_FOUND_COPY = {
	title: "Case not found",
	description: "This support case doesn't exist, or you don't have access to it.",
	back: "Back to cases",
} as const;

/** The support cases list of `orgSlug`: where every way back from a case leads. */
export function casesListHref(orgSlug: string): string {
	return globalHref(orgSlug, "support/my-cases");
}

/**
 * The case-detail region's not-found render: the shared copy and the way back to the list, built
 * with `globalHref` rather than a hand-assembled path.
 */
export function CaseNotFound({ orgSlug }: { orgSlug: string }) {
	return (
		<EmptyState
			className="rounded-md border"
			level={2}
			icon={<SearchX />}
			title={CASE_NOT_FOUND_COPY.title}
			description={CASE_NOT_FOUND_COPY.description}
			action={
				<Button size="sm" nativeButton={false} render={<Link href={casesListHref(orgSlug)} />}>
					{CASE_NOT_FOUND_COPY.back}
				</Button>
			}
		/>
	);
}
