// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatDate } from "@repo/format";
import type { Post } from "@/lib/posts";

/** The tier a news item belongs to; the union comes from the velite schema's `kind` enum. */
export type NewsKind = Post["kind"];

/** The fields the index logic reads, so it can be tested without a velite build. */
export type NewsItem = Pick<Post, "slug" | "kind" | "date" | "featured">;

/** The singular label shown on a card, the hero and the post page. */
export const KIND_LABELS: Record<NewsKind, string> = {
	announcement: "Announcement",
	product: "Product",
	changelog: "Changelog",
	engineering: "Engineering",
	company: "Company",
};

/**
 * The filter chips, in order. `null` is "All". Every kind has a chip, so a reader can see that a
 * tier exists even while it is empty; the empty state says so.
 */
export const KIND_FILTERS: { kind: NewsKind | null; label: string }[] = [
	{ kind: null, label: "All" },
	{ kind: "announcement", label: "Announcements" },
	{ kind: "product", label: "Product" },
	{ kind: "engineering", label: "Engineering" },
	{ kind: "changelog", label: "Changelog" },
	{ kind: "company", label: "Company" },
];

/** Narrows a string to a `NewsKind` without a cast. */
function isNewsKind(value: string): value is NewsKind {
	return Object.hasOwn(KIND_LABELS, value);
}

/**
 * Reads the `?kind=` search param. Anything that is not exactly one known kind (missing,
 * repeated, misspelt) means "All", so a stale or hand-edited URL shows everything rather than
 * an empty list.
 */
export function parseKindFilter(value: string | string[] | undefined): NewsKind | null {
	return typeof value === "string" && isNewsKind(value) ? value : null;
}

/** How many cards one "page" of the grid adds. */
export const PAGE_SIZE = 9;

/**
 * Reads the `?page=` search param as a positive integer; anything else is page 1. The grid shows
 * pages 1..n cumulatively ("Load more" links to n + 1), so a shared link reopens the same list.
 */
export function parsePage(value: string | string[] | undefined): number {
	if (typeof value !== "string" || !/^\d{1,4}$/.test(value)) return 1;
	return Math.max(1, Number(value));
}

/** The first `page * size` items, and whether any are left for "Load more". */
export function paginate<T>(items: T[], page: number, size = PAGE_SIZE): { shown: T[]; hasMore: boolean } {
	const end = page * size;
	return { shown: items.slice(0, end), hasMore: items.length > end };
}

/** The card text for a post: the summary, else the excerpt, else the description. */
export function postSummary(post: Pick<Post, "summary" | "excerpt" | "description">): string {
	return post.summary ?? post.excerpt ?? post.description;
}

/**
 * The hero story: the newest post marked `featured: true`, else the newest announcement, else
 * the newest post that is not a changelog entry, else nothing. `posts` must already be newest
 * first, as `getPublishedPosts` returns them.
 */
export function pickFeatured<T extends NewsItem>(posts: T[]): T | undefined {
	return (
		posts.find((p) => p.featured) ??
		posts.find((p) => p.kind === "announcement") ??
		posts.find((p) => p.kind !== "changelog")
	);
}

/**
 * The top of /news: the hero, then up to `count` secondary stories — other featured posts first,
 * then the newest of the rest. Changelog entries never take a featured slot: they have their own
 * page, and they appear in the grid below.
 */
export function pickFeaturedSet<T extends NewsItem>(posts: T[], count = 3): { hero: T | undefined; secondary: T[] } {
	const hero = pickFeatured(posts);
	const rest = posts.filter((p) => p !== hero && p.kind !== "changelog");
	const secondary = [...rest.filter((p) => p.featured), ...rest.filter((p) => !p.featured)].slice(0, count);
	return { hero, secondary };
}

/**
 * The grid under the filter chips. Unfiltered, it leaves out what the hero and the secondary row
 * already show; filtered by kind, it is every post of that kind, newest first.
 */
export function gridPosts<T extends NewsItem>(posts: T[], kind: NewsKind | null, featured: T[]): T[] {
	if (kind !== null) return posts.filter((p) => p.kind === kind);
	return posts.filter((p) => !featured.includes(p));
}

/**
 * Up to `count` related posts for a post page: the same kind first, then the newest others,
 * never the post itself.
 */
export function relatedPosts<T extends NewsItem>(post: T, posts: T[], count = 3): T[] {
	const others = posts.filter((p) => p.slug !== post.slug);
	return [...others.filter((p) => p.kind === post.kind), ...others.filter((p) => p.kind !== post.kind)].slice(0, count);
}

/** Where a post's real cover image lives, or undefined when it uses generated art. */
export function coverSrc(cover: string | undefined): string | undefined {
	if (!cover) return undefined;
	return cover.startsWith("/") ? cover : `https://assets.alethialabs.io/news/${cover}`;
}

/**
 * "15 Jul 2026". Pinned to UTC: a post's date is a calendar day stored as midnight UTC, and in the
 * server's zone west of Greenwich it would render as the day before.
 */
export function newsDate(iso: string): string {
	return formatDate(iso, "date", "UTC");
}
