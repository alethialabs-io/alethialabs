// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable @next/next/no-html-link-for-pages --
   `/` (console) and `/docs` (docs) are SEPARATE apps on the same domain. They must
   be plain anchors: next/link would prepend this app's `/blog` basePath and break
   the cross-app navigation. In-app links below use next/link. */
import Link from "next/link";
import { Mark } from "@/components/mark";
export function SiteHeader() {
	return (
		<header className="border-b border-border">
			<div className="mx-auto max-w-3xl px-6 h-14 flex items-center justify-between">
				<Link href="/" className="inline-flex items-center gap-2 font-bold">
					<Mark />
					<span>Alethia</span>
					<span className="font-normal text-muted-foreground">Blog</span>
				</Link>
				<nav className="flex items-center gap-5 text-sm text-muted-foreground">
					<a href="/docs" className="hover:text-foreground transition-colors">
						Docs
					</a>
					<a href="/" className="hover:text-foreground transition-colors">
						alethialabs.io
					</a>
				</nav>
			</div>
		</header>
	);
}
