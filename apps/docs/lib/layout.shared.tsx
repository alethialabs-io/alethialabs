// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AlethiaLockup } from "@repo/brand/lockup";
import type { BaseLayoutProps, LinkItemType } from "fumadocs-ui/layouts/shared";

// A single "News" top-nav link to the separate news app (apps/blog). `external` renders a plain
// anchor so it bypasses this app's `/docs` basePath (news is its own app at /news).
export const linkItems: LinkItemType[] = [
	{ type: "main", text: "News", url: "/news", external: true },
];

// The mark was hand-inlined here as a raw <svg>, a third copy of a component this
// app already depends on. A drifted copy of a logo is worse than no copy.
//
// The rest of the lockup used to be hand-composed too — a bare <span>Alethia</span>
// in the body font at font-semibold with no tracking, plus a muted "Docs". That was
// a fourth lockup no other surface rendered, and it is why the docs wordmark never
// matched the console's or the marketing site's. It is now the shared component with
// its own tag.
export const logo = <AlethiaLockup tag="docs" size={22} />;

export function baseOptions(): BaseLayoutProps {
	return {
		nav: {
			title: logo,
		},
		links: linkItems,
	};
}
