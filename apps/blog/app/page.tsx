// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@repo/ui/empty";
import { FeaturedStory } from "@/components/news/featured-story";
import { NewsFilters } from "@/components/news/news-filters";
import { NewsList } from "@/components/news/news-list";
import { buildEntries, KIND_LABELS, parseKindFilter, pickFeatured } from "@/lib/news";
import { getPublishedPosts } from "@/lib/posts";
import { getReleases } from "@/lib/releases";

export const metadata: Metadata = {
	description:
		"Announcements, the changelog and engineering deep dives from Alethia Labs: a multi-cloud control plane you run in your own cloud.",
	alternates: { types: { "application/rss+xml": "/news/feed.xml" } },
};

/**
 * /news: one featured story, the kind chips, then every post and GitHub release in one ruled list,
 * newest first. The filter is the `?kind=` search param, so the page renders per request; the
 * release list behind it is cached for an hour (lib/releases.ts).
 */
export default async function Page(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const { kind: kindParam } = await props.searchParams;
	const kind = parseKindFilter(kindParam);
	const posts = getPublishedPosts();
	const featured = pickFeatured(posts);
	const entries = buildEntries(posts, await getReleases(), kind);

	return (
		<div className="vx-wrap pt-16 pb-18 md:pt-18">
			<h1 className="mb-8 font-grotesk text-display-md font-semibold tracking-[-0.03em] text-text-primary">News</h1>

			{featured && <FeaturedStory post={featured} />}

			<NewsFilters active={kind} />

			{entries.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>{kind ? `No ${KIND_LABELS[kind].toLowerCase()} items yet` : "Nothing published yet"}</EmptyTitle>
						<EmptyDescription>
							Announcements, releases and engineering notes will appear here.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<NewsList entries={entries} />
			)}

			<div className="mt-6 flex gap-2.5">
				{/* A plain anchor: the feed is a route handler, not a page to client-navigate to. */}
				<a
					href="/news/feed.xml"
					className="border border-border px-4 py-2 text-sm text-text-primary no-underline transition-colors hover:border-border-strong"
				>
					RSS
				</a>
				<a
					href="https://github.com/alethialabs-io/alethialabs/releases"
					target="_blank"
					rel="noreferrer noopener"
					className="border border-border px-4 py-2 text-sm text-text-primary no-underline transition-colors hover:border-border-strong"
				>
					All releases on GitHub ↗
				</a>
			</div>
		</div>
	);
}
