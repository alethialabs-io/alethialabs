"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The job route's own 404 (#6121): an address whose id cannot be a job, which `page.tsx` refuses
// before any read. It is the signed-off 404 form (spec §4, #7875): `[ 404 ]`, "Nothing here.", a
// reason line saying the job is what is missing, and the one way back, to this organization's jobs.
//
// The way back is the SAME exit `JobNotFoundState` offers on the detail page for a job that is
// absent or not visible to the reader (R6 D-25), so one condition still has one exit however the
// address was wrong. Non-leaky: an absent job and one in another organization read the same. A
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
