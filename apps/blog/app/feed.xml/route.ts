// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { KIND_LABELS, postSummary } from "@/lib/news";
import { getPublishedPosts } from "@/lib/posts";
import { Feed } from "feed";

const SITE = "https://alethialabs.io";

export const dynamic = "force-static";

/**
 * RSS 2.0 for every post on /news, all kinds (curated changelog entries included), each tagged with
 * its kind as a category. The changelog alone is /news/changelog.xml. The marketing home page reads
 * this feed as its "From News" list, and draws each post's cover from the link's slug and the
 * category (@repo/brand/news-feeds), so the category must stay the kind's label. Subscribers of the old /blog/feed.xml reach it
 * through Caddy's permanent redirect.
 */
export function GET() {
	const feed = new Feed({
		title: "Alethia News",
		description: "Announcements, the changelog and engineering deep dives from Alethia Labs.",
		id: `${SITE}/news`,
		link: `${SITE}/news`,
		language: "en",
		copyright: `© ${new Date().getFullYear()} Alethia Labs`,
		feedLinks: { rss: `${SITE}/news/feed.xml` },
	});

	for (const post of getPublishedPosts()) {
		feed.addItem({
			title: post.title,
			id: `${SITE}${post.permalink}`,
			link: `${SITE}${post.permalink}`,
			description: postSummary(post),
			date: new Date(post.date),
			author: [{ name: post.author }],
			category: [{ name: KIND_LABELS[post.kind] }],
		});
	}

	return new Response(feed.rss2(), {
		headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
	});
}
