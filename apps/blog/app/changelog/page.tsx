// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { RELEASES_URL } from "@repo/brand/news-feeds";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@repo/ui/empty";
import { MDXContent } from "@/components/mdx-content";
import { VersionChips } from "@/components/news/version-chips";
import { changelogEntries } from "@/lib/changelog";
import { newsDate, paginate, parsePage } from "@/lib/news";
import { getPublishedPosts } from "@/lib/posts";

export const metadata: Metadata = {
	title: "Changelog",
	description: "What changed in the Alethia console, CLI and runner, written for the people who use them.",
	alternates: { types: { "application/rss+xml": [{ url: "/news/changelog.xml", title: "Alethia Changelog" }] } },
};

/** Entries per page; older ones are a "Load older entries" link away. */
const ENTRIES_PER_PAGE = 6;

/**
 * /news/changelog: every curated changelog entry rendered IN FULL on one page, newest first, as a
 * timeline — the date and version chips in a left rail, the entry beside it. Entries are
 * `kind: changelog` MDX posts; nothing here reads GitHub.
 */
export default async function Page(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const { page: pageParam } = await props.searchParams;
	const page = parsePage(pageParam);
	const { shown, hasMore } = paginate(changelogEntries(getPublishedPosts()), page, ENTRIES_PER_PAGE);

	return (
		<div className="vx-wrap pt-16 pb-18 md:pt-18">
			<Link href="/" className="text-sm text-text-secondary no-underline hover:text-text-primary">
				← All news
			</Link>
			<h1 className="mt-6 font-grotesk text-display-md font-semibold tracking-[-0.03em] text-text-primary">Changelog</h1>
			<p className="mt-3 max-w-2xl text-text-secondary">
				What changed in the console, the CLI and the runner, roughly once a month and written for the people who use them.
			</p>

			{shown.length === 0 ? (
				<div className="mt-12">
					<Empty>
						<EmptyHeader>
							<EmptyTitle>No changelog entries yet</EmptyTitle>
							<EmptyDescription>Entries appear here as they are published.</EmptyDescription>
						</EmptyHeader>
					</Empty>
				</div>
			) : (
				<ol className="mt-12 border-t border-border">
					{shown.map((entry) => (
						<li key={entry.slug} className="grid gap-4 border-b border-border py-10 md:grid-cols-[200px_minmax(0,1fr)] md:gap-10">
							<div className="flex flex-col gap-3 md:sticky md:top-24 md:self-start">
								<time dateTime={entry.date} className="font-mono text-ui-sm text-text-tertiary">
									{newsDate(entry.date)}
								</time>
								<VersionChips versions={entry.versions} />
							</div>
							<div className="min-w-0">
								<h2 className="font-grotesk text-display-xs font-semibold leading-tight tracking-[-0.02em] text-text-primary">
									<Link href={`/${entry.slug}`} className="no-underline hover:underline hover:underline-offset-4">
										{entry.title}
									</Link>
								</h2>
								<div className="vx-prose mt-4">
									<MDXContent code={entry.code} />
								</div>
							</div>
						</li>
					))}
				</ol>
			)}

			<div className="mt-10 flex flex-wrap gap-2.5">
				{hasMore && (
					<Link
						href={{ pathname: "/changelog", query: { page: page + 1 } }}
						scroll={false}
						className="border border-border px-4 py-2 text-sm text-text-primary no-underline transition-colors hover:border-border-strong"
					>
						Load older entries
					</Link>
				)}
				<a
					href="/news/changelog.xml"
					className="border border-border px-4 py-2 text-sm text-text-primary no-underline transition-colors hover:border-border-strong"
				>
					RSS
				</a>
				<a
					href={RELEASES_URL}
					target="_blank"
					rel="noreferrer noopener"
					className="border border-border px-4 py-2 text-sm text-text-primary no-underline transition-colors hover:border-border-strong"
				>
					Release notes on GitHub ↗
				</a>
			</div>
		</div>
	);
}
