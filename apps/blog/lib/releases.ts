// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The changelog rows on /news, built from this repo's GitHub releases (one per release-please
 * release of the CLI or the runner).
 *
 * TWIN: `releaseTitle`, `releaseSummary` and `parseReleases` are a copy of the same pure helpers
 * in `apps/marketing/lib/home/feeds.ts`, which reads the same API for the home page's changelog.
 * An app may not import from a sibling app (eslint `import/no-restricted-paths`), and that file
 * had not landed on `dev` when this one was written, so there was nothing to promote yet. Once
 * both are on `dev`, promote the three helpers to a `packages/*` module and delete both copies.
 * Until then a change to the parsing belongs in both files.
 *
 * Fetched on the server, cached for an hour, and fail-soft: when GitHub cannot be read the list
 * is empty and /news shows posts only. The page never shows an error for a feed that is down.
 */

const REPO = "alethialabs-io/alethialabs";
const REVALIDATE_SECONDS = 3600;

/** Release-please components whose display name is not just the id capitalised. */
const COMPONENT_NAMES: Record<string, string> = { cli: "CLI" };

/** One release, as /news shows it. */
export interface ReleaseItem {
	/** "Runner v0.10.1": the component name capitalised, then the version. */
	title: string;
	/** ISO date the release was published. */
	date: string;
	/** The first change the release notes list, as plain text; empty when there is none. */
	summary: string;
	/** The release page on GitHub. */
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
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Parses the GitHub releases API response into display items, skipping drafts and pre-releases. */
export function parseReleases(json: unknown, limit: number): ReleaseItem[] {
	if (!Array.isArray(json)) return [];
	const items: ReleaseItem[] = [];
	for (const entry of json) {
		if (!isRecord(entry) || entry.draft === true || entry.prerelease === true) continue;
		const name = str(entry, "name") || str(entry, "tag_name");
		const url = str(entry, "html_url");
		const date = str(entry, "published_at");
		if (!name || !url || !date) continue;
		items.push({ title: releaseTitle(name), date, summary: releaseSummary(str(entry, "body")), url });
		if (items.length === limit) break;
	}
	return items;
}

/**
 * The latest `limit` releases from GitHub, newest first, or [] when GitHub cannot be reached or
 * answers with anything but a release list. One page of the API (at most 100 entries) is read.
 */
export async function getReleases(limit = 30): Promise<ReleaseItem[]> {
	try {
		const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=${Math.min(100, limit * 2)}`, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": "alethia-labs-site" },
			next: { revalidate: REVALIDATE_SECONDS },
		});
		if (!res.ok) return [];
		return parseReleases(await res.json(), limit);
	} catch {
		return [];
	}
}
