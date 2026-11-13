// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Repository } from "@/app/server/actions/git/types";
import type { GitProvider } from "@/lib/db/schema";
import { resolveGitProvider } from "@/lib/git/provider-host";

export interface PreviewRepositoryParts {
	git_provider: Extract<GitProvider, "github" | "gitlab" | "bitbucket">;
	repo_owner: string;
	repo_name: string;
}

/** The owner/repo fields from a URL path of exactly two segments, or null for any other shape. */
function partsFromPath(
	provider: PreviewRepositoryParts["git_provider"],
	pathname: string,
): PreviewRepositoryParts | null {
	const parts = pathname
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.filter(Boolean);
	if (parts.length !== 2) return null;
	const repoName = parts[1].replace(/\.git$/i, "");
	if (!parts[0] || !repoName) return null;
	return {
		git_provider: provider,
		repo_owner: parts[0],
		repo_name: repoName,
	};
}

/**
 * Parses an HTTPS git repository URL into the project_preview_config repo fields. The provider is
 * {@link resolveGitProvider}'s exact-host answer against `gitlabBaseUrl` (github.com, bitbucket.org,
 * the configured GitLab's host and port), so a subdomain, a look-alike and an unknown host all give
 * null rather than a guessed provider. Only an `https://` URL is read: the fields name an owner and a
 * repo, which the URL's path must spell as exactly two segments.
 */
export function parsePreviewRepositoryUrl(
	rawUrl: string,
	gitlabBaseUrl = "https://gitlab.com",
): PreviewRepositoryParts | null {
	const trimmed = rawUrl.trim();
	if (!/^https:\/\//i.test(trimmed)) return null;
	const resolved = resolveGitProvider(trimmed, { gitlabBaseUrl });
	if (!resolved.ok) return null;
	return partsFromPath(resolved.provider, new URL(trimmed).pathname);
}

/** Maps a selected repository row into the project_preview_config repo fields. */
export function previewRepositoryPartsFromRepository(
	repository: Repository,
): PreviewRepositoryParts | null {
	const parts = repository.full_name.split("/").filter(Boolean);
	if (parts.length !== 2) return null;
	return {
		git_provider: repository.provider,
		repo_owner: parts[0],
		repo_name: parts[1],
	};
}
