// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { ErrorState } from "@/components/errors/error-state";
import { Button } from "@repo/ui/button";

/**
 * The job route's own 404 (#6121): an address whose id cannot be a job, which `page.tsx` refuses
 * before any read. It renders inside the shell, so the compact `ErrorState`. A job that exists but
 * is not visible to the reader renders the page's own "Job not found." — the same sentence, so an
 * absent job and an invisible one read the same.
 */
export default function JobNotFound() {
	return (
		<ErrorState
			code="404"
			title="Job not found."
			description="This job has been deleted, or it belongs to an organisation you are not a member of."
			actions={
				<Button size="sm" nativeButton={false} render={<Link href="/" />}>
					Go home
				</Button>
			}
		/>
	);
}
