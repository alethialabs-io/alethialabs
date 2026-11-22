// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SearchX } from "lucide-react";
import Link from "next/link";
import { globalHref } from "@/lib/routing";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";

/** The sentence both job not-found paths say. `deploy-jobs.negative.spec` asserts it exactly. */
export const JOB_NOT_FOUND_TITLE = "Job not found.";

/** Why a job may not be found, without saying which: an absent job and an invisible one read the same. */
export const JOB_NOT_FOUND_DESCRIPTION =
	"This job has been deleted, or it belongs to an organization you are not a member of.";

/**
 * The one "Job not found." state (R6 D-25). The route's `not-found.tsx` (an address whose id cannot
 * be a job) and the detail page (a job that is absent or not visible to the reader) each drew their
 * own — an `ErrorState` with "Go home" and an `EmptyState` with "Back to jobs" — so one condition had
 * two exits depending on how the address was wrong. Both render this now, and the exit is the jobs
 * list of the organization in the address.
 */
export function JobNotFoundState({ orgSlug }: { orgSlug: string }) {
	return (
		<EmptyState
			className="min-h-[50dvh]"
			icon={<SearchX />}
			level={2}
			title={JOB_NOT_FOUND_TITLE}
			description={JOB_NOT_FOUND_DESCRIPTION}
			action={
				// `render` + `nativeButton={false}`, not `asChild`: `@repo/ui/button` is base-ui,
				// which has no `asChild` prop at all.
				<Button variant="outline" size="sm" nativeButton={false} render={<Link href={globalHref(orgSlug, "jobs")} />}>
					Back to jobs
				</Button>
			}
		/>
	);
}
