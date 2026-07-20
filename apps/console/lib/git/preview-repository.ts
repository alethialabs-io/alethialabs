// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Repository } from "@/app/server/actions/git/types";
import type { GitProvider } from "@/lib/db/schema";

export interface PreviewRepositoryParts {
	git_provider: Extract<GitProvider, "github" | "gitlab" | "bitbucket">;
	repo_owner: string;
	repo_name: string;
}

const PROVIDER_HOSTS = {
	"github.com": "github",
	"bitbucket.org": "bitbucket",
} as const;

function hostOf(rawUrl: string): string | null {
	try {
		return new URL(rawUrl).hostname.toLowerCase();
	} catch {
		return null;
	}
}

function gitlabHost(gitlabBaseUrl: string): string {
	return hostOf(gitlabBaseUrl) ?? "gitlab.com";
}

function providerForHost(
	host: string,
	gitlabBaseUrl: string,
): PreviewRepositoryParts["git_provider"] | null {
	for (const [providerHost, provider] of Object.entries(PROVIDER_HOSTS)) {
		if (host === providerHost || host.endsWith(`.${providerHost}`)) {
			return provider;
		}
	}
	const glHost = gitlabHost(gitlabBaseUrl);
	if (host === glHost || host.endsWith(`.${glHost}`)) return "gitlab";
	return null;
}

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

/** Parses an HTTP(S) git repository URL into the project_preview_config repo fields. */
export function parsePreviewRepositoryUrl(
	rawUrl: string,
	gitlabBaseUrl = "https://gitlab.com",
): PreviewRepositoryParts | null {
	let url: URL;
	try {
		url = new URL(rawUrl.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	const provider = providerForHost(url.hostname.toLowerCase(), gitlabBaseUrl);
	if (!provider) return null;
	return partsFromPath(provider, url.pathname);
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
