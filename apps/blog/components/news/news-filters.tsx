// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { KIND_FILTERS, type NewsKind } from "@/lib/news";

/**
 * The kind chips above the /news list. Each is a link to `?kind=…` (All drops the param), so the
 * filter is server-rendered, shareable and works without JavaScript; the active chip carries
 * `aria-current`.
 */
export function NewsFilters({ active }: { active: NewsKind | null }) {
	return (
		<nav aria-label="Filter news" className="mt-7 mb-3.5 flex flex-wrap gap-1.5">
			{KIND_FILTERS.map(({ kind, label }) => {
				const current = kind === active;
				return (
					<Link
						key={label}
						href={kind === null ? "/" : { pathname: "/", query: { kind } }}
						aria-current={current ? "page" : undefined}
						scroll={false}
						className={
							current
								? "border border-text-primary bg-text-primary px-3 py-1.5 font-mono text-ui-sm text-background no-underline"
								: "border border-border px-3 py-1.5 font-mono text-ui-sm text-text-secondary no-underline transition-colors hover:border-border-strong hover:text-text-primary"
						}
					>
						{label}
					</Link>
				);
			})}
		</nav>
	);
}
