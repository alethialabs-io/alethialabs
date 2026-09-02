"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every project-scoped route used to answer a bad PROJECT slug with `[org]/not-found.tsx` —
// "Organization not found… or you don't have access" — which names the wrong resource, and names
// one the reader can see in their own sidebar. `[project]/layout.tsx` and each project page call
// notFound() for an unresolvable project; this is the boundary scoped to that segment.
//
// It renders INSIDE the dashboard chrome: the org layout has already resolved, so AppShell and the
// sidebar are mounted and only the project subtree is replaced. Hence the in-content panel rather
// than the org 404's full-page treatment.
//
// Intentionally non-leaky, exactly as the org 404 is: an unknown project and a forbidden project
// read the same. We never disclose existence.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { orgHref } from "@/lib/routing";
import { ErrorState } from "@/components/errors/error-state";
import { Button } from "@repo/ui/button";

export default function ProjectNotFound() {
	// `/{org}/{project}/…` — the org segment is still valid here (its layout resolved), so the
	// way back is that org's project list rather than the root redirect.
	const org = usePathname().split("/").filter(Boolean)[0];
	return (
		<ErrorState
			code="404"
			title="Project not found"
			description="This project doesn't exist, or you don't have access to it."
			actions={
				<Button
					size="sm"
					nativeButton={false}
					render={<Link href={org ? orgHref(org) : "/"} />}
				>
					All projects
				</Button>
			}
		/>
	);
}
