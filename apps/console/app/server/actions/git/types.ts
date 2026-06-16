// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type for GitHub repository returned by the GitHub API. This is used to type the response when creating a new repository via the GitHub API.
 */
export interface GitHubRepo {
	id: number;
	name: string;
	full_name: string;
	html_url: string;
	private: boolean;
	default_branch: string;
}
/**
 *  Type for GitLab repository returned by the GitLab API. This is used to type the response when creating a new repository via the GitLab API.
 */
export interface GitLabRepo {
	id: number;
	name: string;
	path_with_namespace: string;
	web_url: string;
	visibility: string;
	default_branch?: string;
}

/**
 * Type for Bitbucket repository returned by the Bitbucket API. This is used to type the response when creating a new repository via the Bitbucket API.
 */
export interface BitbucketRepo {
	uuid: string;
	name: string;
	full_name: string;
	is_private: boolean;
	mainbranch?: { name: string };
	links: { html: { href: string } };
}

export interface Repository {
	id: string;
	name: string;
	full_name: string;
	url: string;
	private: boolean;
	default_branch: string;
	provider: "github" | "gitlab" | "bitbucket";
}

export type RepositoryAuthErrorCode =
	| "token_expired"
	| "unauthorized"
	| "missing_token";

export interface FetchRepositoriesResult {
	repositories: Repository[];
	error?: string;
	authErrorCode?: RepositoryAuthErrorCode;
	authProvider?: "github" | "gitlab" | "bitbucket";
}
