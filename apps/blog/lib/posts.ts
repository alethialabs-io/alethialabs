// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { posts as allPosts, type Post } from "#velite";

export type { Post };

const isProd = process.env.NODE_ENV === "production";

/** Published posts (drafts hidden in prod), newest first. */
export function getPublishedPosts(): Post[] {
	return allPosts
		.filter((p) => !p.draft || !isProd)
		.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** A single post by slug, or undefined (drafts excluded in prod). */
export function getPost(slug: string): Post | undefined {
	const post = allPosts.find((p) => p.slug === slug);
	if (!post) return undefined;
	if (post.draft && isProd) return undefined;
	return post;
}

/** ISO date → "June 21, 2026". */
export function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}
