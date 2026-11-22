// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";

import { Chrome } from "./site-chrome";
import { SiteFooter } from "./site-footer";
import { Header } from "./site-header";

/**
 * The chrome every public page wears: frame and rails, one header, one footer.
 *
 * Before this existed the app had four incompatible chrome systems across 22
 * routes — the home page ran a private CSS namespace, the twelve legal pages and
 * `/brand` each drew their own header and footer, and the blog drew a third. The
 * nav changed depending on which page you were on, and the legal pages had no
 * way back into the site at all. One shell is the fix, and the reason this is a
 * component rather than a `layout.tsx`: `apps/blog` is a separate zone and can
 * only share the chrome by importing it.
 *
 * It no longer fetches the GitHub star count: the header stopped showing one when
 * the GitHub link moved to the footer and the Open source page, which fetches
 * its own.
 */
export function SiteShell({
	children,
	homeHref = "/",
}: {
	children: ReactNode;
	homeHref?: "/" | "/home";
}) {
	return (
		<div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
			<Chrome />
			<Header homeHref={homeHref} />
			<main>{children}</main>
			<SiteFooter />
		</div>
	);
}
