import { describe, expect, it } from "vitest";

function parseGithubUrl(url: string): { owner: string; repo: string } | null {
	const httpsMatch = url.match(
		/^https?:\/\/github\.com\/([^/]+)\/([^/.]+)/,
	);
	if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

	const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/.]+)/);
	if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

	return null;
}

describe("parseGithubUrl", () => {
	it("parses HTTPS URLs", () => {
		const result = parseGithubUrl("https://github.com/owner/repo");
		expect(result).toEqual({ owner: "owner", repo: "repo" });
	});

	it("parses HTTPS URLs with .git suffix", () => {
		const result = parseGithubUrl("https://github.com/owner/repo.git");
		expect(result).toEqual({ owner: "owner", repo: "repo" });
	});

	it("parses SSH URLs", () => {
		const result = parseGithubUrl("git@github.com:owner/repo.git");
		expect(result).toEqual({ owner: "owner", repo: "repo" });
	});

	it("parses SSH URLs without .git", () => {
		const result = parseGithubUrl("git@github.com:owner/repo");
		expect(result).toEqual({ owner: "owner", repo: "repo" });
	});

	it("returns null for invalid URLs", () => {
		expect(parseGithubUrl("not-a-url")).toBeNull();
		expect(parseGithubUrl("https://gitlab.com/owner/repo")).toBeNull();
	});
});
