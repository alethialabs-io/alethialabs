// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getReleases } from "@/lib/releases";
import { Feed } from "feed";

const SITE = "https://alethialabs.io";

// Regenerated at most hourly, matching the release fetch's own cache (lib/releases.ts).
export const revalidate = 3600;

/**
 * RSS 2.0 for the changelog rows on /news: one item per CLI or runner release on GitHub, linking to
 * the release page. When GitHub cannot be read the feed is valid and empty rather than an error.
 */
export async function GET() {
	const feed = new Feed({
		title: "Alethia Changelog",
		description: "Releases of the Alethia CLI and runner.",
		id: `${SITE}/news/changelog.xml`,
		link: `${SITE}/news?kind=changelog`,
		language: "en",
		copyright: `© ${new Date().getFullYear()} Alethia Labs`,
		feedLinks: { rss: `${SITE}/news/changelog.xml` },
	});

	for (const release of await getReleases()) {
		feed.addItem({
			title: release.title,
			id: release.url,
			link: release.url,
			description: release.summary || release.title,
			date: new Date(release.date),
		});
	}

	return new Response(feed.rss2(), {
		headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
	});
}
