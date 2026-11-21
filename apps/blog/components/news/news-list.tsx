// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { KIND_LABELS, newsDate, type NewsEntry } from "@/lib/news";

/** The visible part of one row: date · kind · title · arrow. */
function RowBody({ entry }: { entry: NewsEntry }) {
	return (
		<>
			<time dateTime={entry.date} className="font-mono text-ui-sm text-text-tertiary col-start-1 md:row-start-1">
				{newsDate(entry.date)}
			</time>
			<span className="font-mono text-ui-xs uppercase tracking-[0.12em] text-text-secondary col-start-1 md:col-start-2 md:row-start-1">
				{KIND_LABELS[entry.kind]}
			</span>
			<span className="font-grotesk text-ui-xl font-semibold tracking-[-0.015em] text-text-primary group-hover:underline group-hover:underline-offset-4 col-start-1 md:col-start-3 md:row-start-1">
				{entry.title}
			</span>
			<span
				aria-hidden
				className="col-start-2 row-span-3 row-start-1 self-center text-right text-text-tertiary md:col-start-4 md:row-span-1"
			>
				{entry.external ? "↗" : "→"}
			</span>
		</>
	);
}

const ROW =
	"group grid grid-cols-[minmax(0,1fr)_24px] items-baseline gap-x-3 gap-y-1 border-b border-border-faint py-4 no-underline md:grid-cols-[140px_150px_minmax(0,1fr)_24px] md:gap-x-4";

/**
 * The ruled list under the filter chips. A post row links into this app; a changelog row links to
 * its GitHub release in a new tab, and says so to a screen reader.
 */
export function NewsList({ entries }: { entries: NewsEntry[] }) {
	return (
		<ul className="border-t border-border">
			{entries.map((entry) => (
				<li key={entry.key}>
					{entry.external ? (
						<a href={entry.href} target="_blank" rel="noreferrer noopener" className={ROW}>
							<RowBody entry={entry} />
							<span className="sr-only"> (opens GitHub in a new tab)</span>
						</a>
					) : (
						<Link href={entry.href} className={ROW}>
							<RowBody entry={entry} />
						</Link>
					)}
				</li>
			))}
		</ul>
	);
}
