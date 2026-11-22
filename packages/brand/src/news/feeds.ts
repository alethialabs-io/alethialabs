// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one reader for the two public feeds the sites show: this repo's GitHub releases and News's
 * own RSS (`/news/feed.xml`). Promoted here from two twins — `apps/marketing/lib/home/feeds.ts`
 * and `apps/blog/lib/releases.ts` carried the same parsing, and an app may not import a sibling
 * app. The marketing home page reads both feeds; News links its changelog version chips through
 * `releaseUrl`.
 *
 * Both readers fetch on the server, cache for an hour, and fail soft: a feed that cannot be read
 * returns an empty list and its section is not rendered — a page never shows an error or a
 * placeholder for a feed that is down.
 */

const REPO = "alethialabs-io/alethialabs";
const REVALIDATE_SECONDS = 3600;

/** Where News lives; the RSS reader fetches `${NEWS_ORIGIN}/news/feed.xml`. */
const NEWS_ORIGIN = process.env.NEXT_PUBLIC_SITE_URL ?? "https://alethialabs.io";

/** Every release of this repo, on GitHub. */
export const RELEASES_URL = `https://github.com/${REPO}/releases`;

/** The components a changelog entry can name a version of. */
export type ReleaseComponent = "cli" | "runner";

/**
 * The release page for one component version. The runner releases on this repo under
 * release-please's `runner-vX.Y.Z` tag; the CLI publishes on its own public repo under a clean
 * `vX.Y.Z` tag (release-cli.yml), which is where users install it from.
 */
export function releaseUrl(component: ReleaseComponent, version: string): string {
	const v = version.replace(/^v/, "");
	return component === "cli"
		? `https://github.com/alethialabs-io/alethia-cli/releases/tag/v${v}`
		: `https://github.com/${REPO}/releases/tag/runner-v${v}`;
}

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

/** One News post, as the home page shows it. */
export interface PostItem {
	title: string;
	/** ISO date the post was published. */
	date: string;
	description: string;
	url: string;
	/** The last path segment of the post's URL: the seed of its generated cover. */
	slug: string;
	/** The post's kind, lower-cased from the feed's category ("Engineering" → "engineering"). */
	kind: string;
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
 * Parses an RSS 2.0 document into posts, newest first. Only the fields News's own feed writes are
 * read (title, link, description, pubDate, the first category); an item missing title or link is
 * skipped, and one with no category reads as engineering, the schema's default kind.
 */
export function parseRss(xml: string, limit: number): PostItem[] {
	const posts: PostItem[] = [];
	for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const item = match[1] ?? "";
		const title = tag(item, "title");
		const url = tag(item, "link");
		const published = Date.parse(tag(item, "pubDate"));
		if (!title || !url || Number.isNaN(published)) continue;
		const slug = url.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? "";
		const kind = tag(item, "category").toLowerCase() || "engineering";
		posts.push({ title, url, slug, kind, date: new Date(published).toISOString(), description: tag(item, "description") });
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

/** The latest `limit` posts from News's RSS feed, or [] when the feed cannot be read. */
export async function getLatestPosts(limit = 4): Promise<PostItem[]> {
	try {
		const res = await fetch(`${NEWS_ORIGIN}/news/feed.xml`, { next: { revalidate: REVALIDATE_SECONDS } });
		if (!res.ok) return [];
		return parseRss(await res.text(), limit);
	} catch {
		return [];
	}
}
