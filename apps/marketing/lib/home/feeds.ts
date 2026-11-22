// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SITE_URL } from "../site";

/**
 * The two feeds the home page reads: the latest GitHub releases (the changelog) and the latest
 * blog posts (the blog's own RSS). Both are fetched on the server, cached for an hour, and fail
 * soft: a feed that cannot be read returns an empty list and its section is not rendered — the
 * home page never shows an error or a placeholder for a feed that is down.
 */

const REPO = "alethialabs-io/alethialabs";
const REVALIDATE_SECONDS = 3600;

/** Release-please components whose display name is not just the id capitalised. */
const COMPONENT_NAMES: Record<string, string> = { cli: "CLI" };

/** One release, as the home page shows it. */
export interface ReleaseItem {
	/** "Runner v0.10.1" — the component name capitalised, then the version. */
	title: string;
	/** ISO date the release was published. */
	date: string;
	/** The first change the release notes list, as plain text; empty when there is none. */
	summary: string;
	/** The release page on GitHub. */
	url: string;
}

/** One blog post, as the home page shows it. */
export interface PostItem {
	title: string;
	/** ISO date the post was published. */
	date: string;
	description: string;
	url: string;
}

/** Whether `value` is a non-null object, so its fields can be read without a cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Reads a string field, or "" when it is missing or not a string. */
function str(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : "";
}

/**
 * Turns a release-please release name ("runner: v0.10.1") into a display title ("Runner v0.10.1").
 * A name without a component prefix is returned trimmed.
 */
export function releaseTitle(name: string): string {
	const match = /^\s*([a-z0-9-]+)\s*:\s*(v?\d[^\s]*)\s*$/i.exec(name);
	if (!match) return name.trim();
	const component = match[1] ?? "";
	const version = match[2] ?? "";
	const label = COMPONENT_NAMES[component.toLowerCase()] ?? component.charAt(0).toUpperCase() + component.slice(1);
	return `${label} ${version}`;
}

/**
 * The first bullet of a release-please body, as plain text: markdown links keep their text, bold
 * scopes and trailing PR / commit references are dropped, and the first letter is capitalised
 * (commit subjects are written lower-case). Returns "" when the body has no bullet.
 */
export function releaseSummary(body: string): string {
	const bullet = body.split("\n").find((line) => /^\s*[*-]\s+/.test(line));
	if (!bullet) return "";
	const text = bullet
		.replace(/^\s*[*-]\s+/, "")
		.replace(/\*\*[^*]+:\*\*\s*/g, "")
		.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	// Early releases lead with a bare commit hash ("7ed185b0e026… fix: …") — meaningless to a reader,
	// and an unbreakable 40-character string. Strip it; a summary that was only a hash is no summary.
	const clean = text.replace(/^[0-9a-f]{7,40}\b\s*/, "").trim();
	if (clean.length < 3) return "";
	return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Parses the GitHub releases API response into display items, skipping drafts and pre-releases. */
export function parseReleases(json: unknown, limit: number): ReleaseItem[] {
	if (!Array.isArray(json)) return [];
	const items: ReleaseItem[] = [];
	for (const entry of json) {
		if (!isRecord(entry) || entry.draft === true || entry.prerelease === true) continue;
		const name = str(entry, "name") || str(entry, "tag_name");
		// Only release-please releases ("runner: v0.10.1"). The bare "v0.x" tags before it carry raw
		// commit subjects and merge messages, which are not release notes.
		if (!/^\s*[a-z0-9-]+\s*:\s*v?\d/i.test(name)) continue;
		const url = str(entry, "html_url");
		const date = str(entry, "published_at");
		if (!name || !url || !date) continue;
		items.push({ title: releaseTitle(name), date, summary: releaseSummary(str(entry, "body")), url });
		if (items.length === limit) break;
	}
	return items;
}

/** Decodes the five XML entities and unwraps CDATA. */
function xmlText(raw: string): string {
	const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
	const text = cdata?.[1] ?? raw;
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&")
		.trim();
}

/** Reads one child element's text out of an RSS <item>, or "" when it is absent. */
function tag(item: string, name: string): string {
	const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(item);
	return match?.[1] !== undefined ? xmlText(match[1]) : "";
}

/**
 * Parses an RSS 2.0 document into posts, newest first. Only the fields the blog's own feed
 * writes are read (title, link, description, pubDate); an item missing title or link is skipped.
 */
export function parseRss(xml: string, limit: number): PostItem[] {
	const posts: PostItem[] = [];
	for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const item = match[1] ?? "";
		const title = tag(item, "title");
		const url = tag(item, "link");
		const published = Date.parse(tag(item, "pubDate"));
		if (!title || !url || Number.isNaN(published)) continue;
		posts.push({ title, url, date: new Date(published).toISOString(), description: tag(item, "description") });
	}
	return posts.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}

/** The latest `limit` releases from GitHub, or [] when GitHub cannot be reached. */
export async function getLatestReleases(limit = 3): Promise<ReleaseItem[]> {
	try {
		const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=${limit * 3}`, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": "alethia-labs-site" },
			next: { revalidate: REVALIDATE_SECONDS },
		});
		if (!res.ok) return [];
		return parseReleases(await res.json(), limit);
	} catch {
		return [];
	}
}

/** The latest `limit` blog posts from the blog's RSS feed, or [] when the feed cannot be read. */
export async function getLatestPosts(limit = 4): Promise<PostItem[]> {
	try {
		const res = await fetch(`${SITE_URL}/news/feed.xml`, { next: { revalidate: REVALIDATE_SECONDS } });
		if (!res.ok) return [];
		return parseRss(await res.text(), limit);
	} catch {
		return [];
	}
}
