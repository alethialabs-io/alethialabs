"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { getOwner } from "@/lib/auth/owner";
import { getLinkedProviders, getValidProviderToken } from "../identities";
import {
	BitbucketRepo,
	FetchRepositoriesResult,
	GitHubRepo,
	GitLabRepo,
	Repository,
} from "./types";

export async function fetchAllRepositories(): Promise<{
	repositories: Repository[];
	error?: string;
}> {
	try {
		// Git providers the user has linked (Better Auth accounts).
		const providers = await getLinkedProviders();
		if (providers.length === 0) {
			return { repositories: [] };
		}

		const allRepos: Repository[] = [];

		await Promise.all(
			providers.map(async (provider) => {
				try {
					const token = await getValidProviderToken(provider);
					if (!token) return;

					if (provider === "github") {
						const res = await fetch(
							"https://api.github.com/user/repos?per_page=100&sort=updated",
							{
								headers: {
									Authorization: `Bearer ${token}`,
									Accept: "application/vnd.github.v3+json",
								},
							},
						);
						if (res.ok) {
							const repos = await res.json();
							allRepos.push(
								...repos.map((repo: GitHubRepo) => ({
									id: repo.id.toString(),
									name: repo.name,
									full_name: repo.full_name,
									url: repo.html_url,
									private: repo.private,
									default_branch: repo.default_branch,
									provider: "github" as const,
								})),
							);
						}
					} else if (provider === "gitlab") {
						const res = await fetch(
							"https://gitlab.itgix.com/api/v4/projects?membership=true&per_page=100&order_by=updated_at",
							{
								headers: {
									Authorization: `Bearer ${token}`,
								},
							},
						);
						if (res.ok) {
							const repos = await res.json();
							allRepos.push(
								...repos.map((repo: GitLabRepo) => ({
									id: repo.id.toString(),
									name: repo.name,
									full_name: repo.path_with_namespace,
									url: repo.web_url,
									private: repo.visibility !== "public",
									default_branch:
										repo.default_branch || "main",
									provider: "gitlab" as const,
								})),
							);
						}
					} else if (provider === "bitbucket") {
						const res = await fetch(
							"https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100",
							{
								headers: {
									Authorization: `Bearer ${token}`,
									Accept: "application/json",
								},
							},
						);
						if (res.ok) {
							const data = await res.json();
							allRepos.push(
								...(data.values || []).map(
									(repo: BitbucketRepo) => ({
										id: repo.uuid,
										name: repo.name,
										full_name: repo.full_name,
										url: repo.links.html.href,
										private: repo.is_private,
										default_branch:
											repo.mainbranch?.name || "main",
										provider: "bitbucket" as const,
									}),
								),
							);
						}
					}
				} catch (err) {
					console.error(`Error fetching ${provider} repos:`, err);
				}
			}),
		);

		return { repositories: allRepos };
	} catch (error) {
		console.error("Error fetching all repositories:", error);
		return { repositories: [], error: "Failed to fetch repositories" };
	}
}

export async function createRepository(
	provider: "github" | "gitlab" | "bitbucket",
	data: { name: string; workspace?: string; projectKey?: string },
): Promise<{ repository?: Repository; error?: string }> {
	try {
		const userId = await getOwner();
		if (!userId) {
			return { error: "Unauthorized" };
		}

		const token = await getValidProviderToken(provider);
		if (!token) {
			return {
				error: `No ${provider} token found. Please link your ${provider} account.`,
			};
		}

		let newRepo;
		let repository: Repository;

		if (provider === "github") {
			if (!data.name) return { error: "Repository name is required." };

			const res = await fetch("https://api.github.com/user/repos", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github.v3+json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ name: data.name, private: false }),
			});
			if (!res.ok) {
				const errorData = await res.json();
				return {
					error: `Failed to create GitHub repository: ${errorData.message}`,
				};
			}
			newRepo = await res.json();
			repository = {
				id: newRepo.id.toString(),
				name: newRepo.name,
				full_name: newRepo.full_name,
				url: newRepo.html_url,
				private: newRepo.private,
				default_branch: newRepo.default_branch,
				provider: "github" as const,
			};
		} else if (provider === "gitlab") {
			if (!data.name) return { error: "Repository name is required." };

			const res = await fetch(
				"https://gitlab.itgix.com/api/v4/projects",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						name: data.name,
						visibility: "public",
					}),
				},
			);
			if (!res.ok) {
				const errorData = await res.json();
				return {
					error: `Failed to create GitLab repository: ${errorData.message?.name?.[0] || errorData.message}`,
				};
			}
			newRepo = await res.json();
			repository = {
				id: newRepo.id.toString(),
				name: newRepo.name,
				full_name: newRepo.path_with_namespace,
				url: newRepo.web_url,
				private: newRepo.visibility !== "public",
				default_branch: newRepo.default_branch || "main",
				provider: "gitlab" as const,
			};
		} else if (provider === "bitbucket") {
			if (!data.name || !data.workspace || !data.projectKey) {
				return {
					error: "Repository name, workspace, and project key are required.",
				};
			}

			const res = await fetch(
				`https://api.bitbucket.org/2.0/repositories/${data.workspace}/${data.name}`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						scm: "git",
						project: { key: data.projectKey },
						is_private: false,
					}),
				},
			);
			if (!res.ok) {
				const errorData = await res.json();
				return {
					error: `Failed to create Bitbucket repository: ${errorData.error.message}`,
				};
			}
			newRepo = await res.json();
			repository = {
				id: newRepo.uuid,
				name: newRepo.name,
				full_name: newRepo.full_name,
				url: newRepo.links.html.href,
				private: newRepo.is_private,
				default_branch: newRepo.mainbranch?.name || "main",
				provider: "bitbucket" as const,
			};
		} else {
			return { error: "Unsupported provider" };
		}

		return { repository };
	} catch (error) {
		console.error(`Error creating ${provider} repository:`, error);
		return { error: "Failed to create repository" };
	}
}


export async function fetchRepositoriesByProvider(
	provider: "github" | "gitlab" | "bitbucket",
): Promise<FetchRepositoriesResult> {
	try {
		const token = await getValidProviderToken(provider);
		if (!token) {
			return {
				repositories: [],
				error: `No token found for ${provider}`,
				authErrorCode: "missing_token",
				authProvider: provider,
			};
		}

		const allRepos: Repository[] = [];

		if (provider === "github") {
			const res = await fetch(
				"https://api.github.com/user/repos?per_page=100&sort=updated",
				{
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/vnd.github.v3+json",
					},
				},
			);
			if (res.ok) {
				const repos = await res.json();
				allRepos.push(
					...repos.map((repo: GitHubRepo) => ({
						id: repo.id.toString(),
						name: repo.name,
						full_name: repo.full_name,
						url: repo.html_url,
						private: repo.private,
						default_branch: repo.default_branch,
						provider: "github" as const,
					})),
				);
			} else {
				return {
					repositories: [],
					error: `Failed to fetch GitHub repos: ${await res.text()}`,
					authErrorCode: res.status === 401 ? "unauthorized" : undefined,
					authProvider: res.status === 401 ? provider : undefined,
				};
			}
		} else if (provider === "gitlab") {
			const res = await fetch(
				"https://gitlab.itgix.com/api/v4/projects?membership=true&per_page=100&order_by=updated_at",
				{
					headers: {
						Authorization: `Bearer ${token}`,
					},
				},
			);
			if (res.ok) {
				const repos = await res.json();
				allRepos.push(
					...repos.map((repo: GitLabRepo) => ({
						id: repo.id.toString(),
						name: repo.name,
						full_name: repo.path_with_namespace,
						url: repo.web_url,
						private: repo.visibility !== "public",
						default_branch: repo.default_branch || "main",
						provider: "gitlab" as const,
					})),
				);
			} else {
				return {
					repositories: [],
					error: `Failed to fetch GitLab repos: ${await res.text()}`,
					authErrorCode: res.status === 401 ? "unauthorized" : undefined,
					authProvider: res.status === 401 ? provider : undefined,
				};
			}
		} else if (provider === "bitbucket") {
			const res = await fetch(
				"https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100",
				{
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/json",
					},
				},
			);
			if (res.ok) {
				const data = await res.json();
				allRepos.push(
					...(data.values || []).map((repo: BitbucketRepo) => ({
						id: repo.uuid,
						name: repo.name,
						full_name: repo.full_name,
						url: repo.links.html.href,
						private: repo.is_private,
						default_branch: repo.mainbranch?.name || "main",
						provider: "bitbucket" as const,
					})),
				);
			} else {
				const errorBody = await res.text();
				const isExpired =
					res.status === 401 &&
					errorBody.includes("OAuth2 access token expired");
				return {
					repositories: [],
					error: `Failed to fetch Bitbucket repos: ${errorBody}`,
					authErrorCode: isExpired
						? "token_expired"
						: res.status === 401
							? "unauthorized"
							: undefined,
					authProvider: res.status === 401 ? provider : undefined,
				};
			}
		}

		return { repositories: allRepos };
	} catch (error) {
		console.error(`Error fetching ${provider} repositories:`, error);
		return {
			repositories: [],
			error:
				error instanceof Error
					? error.message
					: "Failed to fetch repositories",
		};
	}
}
