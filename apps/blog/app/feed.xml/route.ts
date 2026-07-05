// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getPublishedPosts } from "@/lib/posts";
import { Feed } from "feed";

const SITE = "https://alethialabs.io";

export const dynamic = "force-static";

export function GET() {
	const feed = new Feed({
		title: "Alethia Blog",
		description: "Engineering deep dives from Alethia Labs.",
		id: `${SITE}/blog`,
		link: `${SITE}/blog`,
		language: "en",
		copyright: `© ${new Date().getFullYear()} Alethia Labs`,
		feedLinks: { rss: `${SITE}/blog/feed.xml` },
	});

	for (const post of getPublishedPosts()) {
		feed.addItem({
			title: post.title,
			id: `${SITE}${post.permalink}`,
			link: `${SITE}${post.permalink}`,
			description: post.excerpt ?? post.description,
			date: new Date(post.date),
			author: [{ name: post.author }],
		});
	}

	return new Response(feed.rss2(), {
		headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
	});
}
