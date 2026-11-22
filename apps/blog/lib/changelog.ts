// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { releaseUrl, type ReleaseComponent } from "@repo/brand/news-feeds";
import type { Post } from "@/lib/posts";

/**
 * The changelog is curated: `kind: changelog` MDX entries, each a headline item then New /
 * Improved / Fixed in plain language. A draft is opened weekly from merged PRs by
 * scripts/news/draft-changelog.mjs and rewritten by a person before it is published. Raw GitHub
 * release notes are engineering-facing and are never shown here; an entry links the versions it
 * covers instead.
 */

/** The fields the changelog reads, so it can be tested without a velite build. */
export type ChangelogItem = Pick<Post, "kind" | "date" | "versions">;

/** One version chip: "CLI v0.10.0" linking to its release. */
export interface VersionChip {
	label: string;
	href: string;
}

const COMPONENT_LABELS: Record<ReleaseComponent, string> = { cli: "CLI", runner: "Runner" };

/** The CLI chip first, then the runner, each only when the entry names that version. */
export function versionChips(versions: ChangelogItem["versions"]): VersionChip[] {
	if (!versions) return [];
	const chips: VersionChip[] = [];
	for (const component of ["cli", "runner"] as const) {
		const version = versions[component];
		if (!version) continue;
		chips.push({ label: `${COMPONENT_LABELS[component]} v${version.replace(/^v/, "")}`, href: releaseUrl(component, version) });
	}
	return chips;
}

/** Only the changelog entries of `posts`, newest first (stable for entries on the same day). */
export function changelogEntries<T extends ChangelogItem>(posts: T[]): T[] {
	return posts
		.map((post, index) => ({ post, index }))
		.filter(({ post }) => post.kind === "changelog")
		.sort((a, b) => Date.parse(b.post.date) - Date.parse(a.post.date) || a.index - b.index)
		.map(({ post }) => post);
}
