// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

const REPO = "alethialabs-io/alethialabs";

/**
 * Fetches the public star count for the Alethia repo, cached hourly. Returns
 * `null` when the API is unreachable or the repo isn't public yet, so callers
 * can degrade to an icon-only GitHub link without crashing.
 */
export async function getGitHubStars(): Promise<number | null> {
	try {
		const res = await fetch(`https://api.github.com/repos/${REPO}`, {
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "alethia-labs-site",
			},
			next: { revalidate: 3600 },
		});
		if (!res.ok) return null;
		const data: unknown = await res.json();
		if (typeof data === "object" && data !== null && "stargazers_count" in data) {
			const count = data.stargazers_count;
			if (typeof count === "number") return count;
		}
		return null;
	} catch {
		return null;
	}
}
