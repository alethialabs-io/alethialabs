// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { KIND_LABELS, postSummary } from "@/lib/news";
import { getPublishedPosts } from "@/lib/posts";
import { Feed } from "feed";

const SITE = "https://alethialabs.io";

export const dynamic = "force-static";

/**
 * RSS 2.0 for every post on /news, all kinds, each tagged with its kind as a category. Releases
 * are not in it: they have their own feed at /news/changelog.xml, and the marketing home page
 * reads this one as its "latest posts" list. Subscribers of the old /blog/feed.xml reach it
 * through Caddy's permanent redirect.
 */
export function GET() {
	const feed = new Feed({
		title: "Alethia News",
		description: "Announcements and engineering deep dives from Alethia Labs.",
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
