// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatDate } from "@repo/format";
import type { Post } from "@/lib/posts";
import type { ReleaseItem } from "@/lib/releases";

/** The tier a news item belongs to; the union comes from the velite schema's `kind` enum. */
export type NewsKind = Post["kind"];

/** The singular label shown on a row and on the featured card. */
export const KIND_LABELS: Record<NewsKind, string> = {
	announcement: "Announcement",
	changelog: "Changelog",
	engineering: "Engineering",
	company: "Company",
};

/**
 * The filter chips, in order. `null` is "All". Company has no chip until there is a company post
 * to show; `?kind=company` still filters, because every kind is a valid filter value.
 */
export const KIND_FILTERS: { kind: NewsKind | null; label: string }[] = [
	{ kind: null, label: "All" },
	{ kind: "announcement", label: "Announcements" },
	{ kind: "changelog", label: "Changelog" },
	{ kind: "engineering", label: "Engineering" },
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

/** One row of the /news list: a post on this site or a release on GitHub. */
export interface NewsEntry {
	/** Stable React key. */
	key: string;
	/** ISO date or timestamp, used for ordering. */
	date: string;
	kind: NewsKind;
	title: string;
	/** For a post, a path under this app's basePath; for a release, the absolute GitHub URL. */
	href: string;
	/** True for a release: it opens GitHub in a new tab. */
	external: boolean;
}

/** The card text for a post: the summary, else the excerpt, else the description. */
export function postSummary(post: Post): string {
	return post.summary ?? post.excerpt ?? post.description;
}

/**
 * The featured story: the newest post marked `featured: true`, else the newest announcement,
 * else nothing (the page then opens on the list). `posts` must already be newest first, as
 * `getPublishedPosts` returns them.
 */
export function pickFeatured(posts: Post[]): Post | undefined {
	return posts.find((p) => p.featured) ?? posts.find((p) => p.kind === "announcement");
}

/**
 * Posts and releases as one list, newest first, narrowed to `kind` when one is given. A release
 * row reads "Runner v0.10.1 — <first change>", or just the title when the notes list no change.
 */
export function buildEntries(posts: Post[], releases: ReleaseItem[], kind: NewsKind | null): NewsEntry[] {
	const entries: NewsEntry[] = [
		...posts.map((post): NewsEntry => ({
			key: `post:${post.slug}`,
			date: post.date,
			kind: post.kind,
			title: post.title,
			href: `/${post.slug}`,
			external: false,
		})),
		...releases.map((release): NewsEntry => ({
			key: `release:${release.url}`,
			date: release.date,
			kind: "changelog",
			title: release.summary ? `${release.title} — ${release.summary}` : release.title,
			href: release.url,
			external: true,
		})),
	];
	return entries
		.filter((entry) => kind === null || entry.kind === kind)
		.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

/**
 * "15 Jul 2026". Pinned to UTC: a post's date is a calendar day stored as midnight UTC, and in the
 * server's zone west of Greenwich it would render as the day before.
 */
export function newsDate(iso: string): string {
	return formatDate(iso, "date", "UTC");
}
