"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The boundary scoped to the PROJECT segment. Before #3880 every `[project]/**` route resolved to
// `[org]/not-found.tsx` and a bad project slug answered "Organization not found… or you don't have
// access", naming a resource that is plainly fine. This sits in the `[project]` segment, so it
// covers the throw each page makes when `resolveProjectId` fails — and it renders inside AppShell
// (the org resolved) but outside ProjectShell (there is no project to hang the dock on).
//
// Non-leaky like the org one: a project that never existed and a project belonging to another org
// read the same — we never disclose existence.
//
// The signed-off 404 form (spec §4, #7875): `[ 404 ]`, "Nothing here.", then the reason line, which
// names the project as the missing thing and the org it was looked for in. That line is what tells
// this boundary apart from the org-level fallback (e2e navigation-shell and projects specs).

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ErrorState } from "@repo/ui/error-state";
import { orgHref } from "@/lib/routing";
import { Button } from "@repo/ui/button";

/** The project segment's 404: says the project is what is missing, and leads back to the org's projects. */
export default function ProjectNotFound() {
	// `/{org}/{project}/…` — the org segment resolved, so the way back is its project list.
	const org = usePathname().split("/").filter(Boolean)[0];
	return (
		<ErrorState
			code="404"
			codeVariant="bracketed"
			title="Nothing here."
			description={
				org
					? `This project doesn't exist in ${org}, or you don't have access to it.`
					: "This project doesn't exist, or you don't have access to it."
			}
			actions={
				// The only way out of this page — an `<a href>` — is announced as a link, as on the
				// other two 404 boundaries: `@repo/ui/button` gives a `render` element with an
				// `href` `role="link"` (#5444). See `[org]/not-found.tsx`.
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
