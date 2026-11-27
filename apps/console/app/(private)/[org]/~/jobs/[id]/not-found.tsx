"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The job route's own 404, and the ONE answer for a job that is not there (R6 D-25). Two throws
// reach it: `page.tsx` refuses an id that cannot be a job before any read (#6121), and `JobDetail`
// calls notFound() when a well-formed id's read settles with no job the reader can see (#7875). So
// however the address was wrong it reads the same, in the signed-off 404 form (spec §4): `[ 404 ]`,
// "Nothing here.", a reason line saying the job is what is missing, and the one way back, to this
// organization's jobs. Non-leaky: an absent job and one in another organization read the same. A
// `not-found` file receives no params, so the organization is read from the address.

import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@repo/ui/button";
import { ErrorState } from "@repo/ui/error-state";
import { globalHref } from "@/lib/routing";

/** The job route's 404: the job is what is missing, and the way back is this organization's jobs. */
export default function JobNotFound() {
	const { org } = useParams<{ org: string }>();
	return (
		<ErrorState
			code="404"
			codeVariant="bracketed"
			title="Nothing here."
			description="This job doesn't exist, or it belongs to another organization."
			actions={
				<Button size="sm" nativeButton={false} render={<Link href={globalHref(org, "jobs")} />}>
					Back to jobs
				</Button>
			}
		/>
	);
}
