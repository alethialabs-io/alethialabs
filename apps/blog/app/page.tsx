// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@repo/ui/empty";
import { FeaturedRow, FeaturedStory } from "@/components/news/featured-story";
import { NewsFilters } from "@/components/news/news-filters";
import { NewsGrid } from "@/components/news/news-grid";
import { gridPosts, KIND_LABELS, paginate, parseKindFilter, parsePage, pickFeaturedSet } from "@/lib/news";
import { getPublishedPosts } from "@/lib/posts";

export const metadata: Metadata = {
	description:
		"Announcements, the changelog and engineering deep dives from Alethia Labs: a multi-cloud control plane you run in your own cloud.",
	alternates: {
		types: { "application/rss+xml": [{ url: "/news/feed.xml", title: "Alethia News" }, { url: "/news/changelog.xml", title: "Alethia Changelog" }] },
	},
};

const BUTTON =
	"border border-border px-4 py-2 text-sm text-text-primary no-underline transition-colors hover:border-border-strong";

/**
 * /news. Unfiltered: the hero story, a secondary row of up to three featured cards, the kind chips,
 * then a card grid of everything else. Filtered by `?kind=`: the chips and that kind's cards only.
 * `?page=` grows the grid ("Load more"). Every post is MDX in this app — the changelog included,
 * as curated `kind: changelog` entries — so nothing here waits on a network read.
 */
export default async function Page(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const { kind: kindParam, page: pageParam } = await props.searchParams;
	const kind = parseKindFilter(kindParam);
	const page = parsePage(pageParam);
	const posts = getPublishedPosts();
	const { hero, secondary } = pickFeaturedSet(posts);
	const featured = kind === null && hero ? [hero, ...secondary] : [];
	const { shown, hasMore } = paginate(gridPosts(posts, kind, featured), page);

	return (
		<div className="vx-wrap pt-16 pb-18 md:pt-18">
			<h1 className="mb-10 font-grotesk text-display-md font-semibold tracking-[-0.03em] text-text-primary">News</h1>

			{kind === null && hero && (
				<>
					<FeaturedStory post={hero} />
					<FeaturedRow posts={secondary} />
				</>
			)}

			<div className="mt-14 mb-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6">
				<NewsFilters active={kind} />
				<Link href="/changelog" className="font-mono text-ui-sm text-text-secondary no-underline hover:text-text-primary">
					Full changelog →
				</Link>
			</div>

			{shown.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>{kind ? `No ${KIND_LABELS[kind].toLowerCase()} posts yet` : "Nothing more to show"}</EmptyTitle>
						<EmptyDescription>Announcements, changelog entries and engineering notes will appear here.</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<NewsGrid posts={shown} kind={kind} page={page} hasMore={hasMore} />
			)}

			<div className="mt-14 flex flex-wrap gap-2.5">
				{/* Plain anchors: the feeds are route handlers, not pages to client-navigate to. */}
				<a href="/news/feed.xml" className={BUTTON}>
					RSS
				</a>
				<a href="/news/changelog.xml" className={BUTTON}>
					Changelog RSS
				</a>
			</div>
		</div>
	);
}
