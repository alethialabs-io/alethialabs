// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { changelogEntries } from "@/lib/changelog";
import { postSummary } from "@/lib/news";
import { getPublishedPosts } from "@/lib/posts";
import { Feed } from "feed";

const SITE = "https://alethialabs.io";

export const dynamic = "force-static";

/**
 * RSS 2.0 for the changelog: one item per curated `kind: changelog` entry, linking to the entry's
 * own page. Built from the MDX at build time, like /news/feed.xml — GitHub release notes are not
 * in it.
 */
export function GET() {
	const feed = new Feed({
		title: "Alethia Changelog",
		description: "What changed in the Alethia console, CLI and runner.",
		id: `${SITE}/news/changelog`,
		link: `${SITE}/news/changelog`,
		language: "en",
		copyright: `© ${new Date().getFullYear()} Alethia Labs`,
		feedLinks: { rss: `${SITE}/news/changelog.xml` },
	});

	for (const entry of changelogEntries(getPublishedPosts())) {
		feed.addItem({
			title: entry.title,
			id: `${SITE}${entry.permalink}`,
			link: `${SITE}${entry.permalink}`,
			description: postSummary(entry),
			date: new Date(entry.date),
			author: [{ name: entry.author }],
			category: [{ name: "Changelog" }],
		});
	}

	return new Response(feed.rss2(), {
		headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
	});
}
