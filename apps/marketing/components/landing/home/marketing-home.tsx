// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SiteShell } from "@repo/brand/site-shell";
import { getLatestPosts, getLatestReleases } from "@/lib/home/feeds";
import { Film, FromTheBlog, Latest, Statement } from "./home-sections";

/**
 * The home page, in the editorial order the maintainer chose (modelled on anthropic.com's
 * structure, not its content): a statement, the film, the latest three releases from the
 * changelog, four posts from the blog. The two feeds are fetched in parallel and cached for an
 * hour; either one failing only removes its own section.
 */
export async function MarketingHome({ homeHref = "/" }: { homeHref?: "/" | "/home" }) {
	const [releases, posts] = await Promise.all([getLatestReleases(3), getLatestPosts(4)]);
	return (
		<SiteShell homeHref={homeHref}>
			<Statement />
			<Film />
			<Latest releases={releases} />
			<FromTheBlog posts={posts} />
		</SiteShell>
	);
}
