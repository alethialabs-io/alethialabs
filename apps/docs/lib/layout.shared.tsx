// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AlethiaLogo } from "@repo/brand/alethia-logo";
import type { BaseLayoutProps, LinkItemType } from "fumadocs-ui/layouts/shared";

// A single "Blog" top-nav link to the separate blog app. `external` renders a plain
// anchor so it bypasses this app's `/docs` basePath (the blog is its own app at /blog).
export const linkItems: LinkItemType[] = [
	{ type: "main", text: "Blog", url: "/blog", external: true },
];

// The mark was hand-inlined here as a raw <svg>, a third copy of a component this
// app already depends on. A drifted copy of a logo is worse than no copy.
export const logo = (
	<span className="inline-flex items-center gap-2 font-semibold">
		<AlethiaLogo className="size-5" />
		<span>Alethia</span>
		<span className="font-normal text-fd-muted-foreground">Docs</span>
	</span>
);

export function baseOptions(): BaseLayoutProps {
	return {
		nav: {
			title: logo,
		},
		links: linkItems,
	};
}
