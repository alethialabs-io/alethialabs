"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The other route whose notFound() resolved all the way up to `[org]/not-found.tsx`: a case id that
// is not visible to you answered "Organization not found", naming a resource that is plainly fine.
// `page.tsx` calls notFound() when `getCase` returns nothing; this is the boundary scoped to the
// case segment, and it renders inside SupportShell with the rest of the chrome intact.
//
// Non-leaky like the other two: a case that never existed and a case belonging to another org read
// the same. The wording and the way back are the case-detail region's own (`case-not-found.tsx`,
// G-25), so a case that is missing on arrival and one that went away while open read alike.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ErrorState } from "@/components/errors/error-state";
import { CASE_NOT_FOUND_COPY, casesListHref } from "@/components/support/cases/case-not-found";
import { Button } from "@repo/ui/button";

/** The case segment's 404: the shared "Case not found" copy, with the way back to the cases list. */
export default function SupportCaseNotFound() {
	// `/{org}/~/support/cases/{id}` — the org segment resolved, so the way back is its case list.
	const org = usePathname().split("/").filter(Boolean)[0];
	return (
		<ErrorState
			code="404"
			title={CASE_NOT_FOUND_COPY.title}
			description={CASE_NOT_FOUND_COPY.description}
			actions={
				<Button
					size="sm"
					nativeButton={false}
					render={<Link href={org ? casesListHref(org) : "/"} />}
				>
					{CASE_NOT_FOUND_COPY.back}
				</Button>
			}
		/>
	);
}
