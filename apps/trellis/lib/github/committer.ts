import { Octokit } from "@octokit/rest";

/**
 * Parses a git URL to extract owner and repo.
 * Supports:
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 */
function parseGithubUrl(url: string) {
	let cleanUrl = url.replace(/\.git$/, "");
	if (cleanUrl.startsWith("https://github.com/")) {
		const parts = cleanUrl.replace("https://github.com/", "").split("/");
		return { owner: parts[0], repo: parts[1] };
	} else if (cleanUrl.startsWith("git@github.com:")) {
		const parts = cleanUrl.replace("git@github.com:", "").split("/");
		return { owner: parts[0], repo: parts[1] };
	}
	throw new Error(`Unsupported GitHub URL format: ${url}`);
}

export async function commitFilesToGitHub({
	repoUrl,
	branch,
	token,
	files,
	message,
}: {
	repoUrl: string;
	branch: string;
	token: string;
	files: { path: string; content: string }[];
	message: string;
}) {
	const octokit = new Octokit({ auth: token });
	const { owner, repo } = parseGithubUrl(repoUrl);

	// 1. Get the current branch reference
	const refResponse = await octokit.git.getRef({
		owner,
		repo,
		ref: `heads/${branch}`,
	});
	const latestCommitSha = refResponse.data.object.sha;

	// 2. Get the latest commit
	const commitResponse = await octokit.git.getCommit({
		owner,
		repo,
		commit_sha: latestCommitSha,
	});
	const baseTreeSha = commitResponse.data.tree.sha;

	// 3. Create blobs for the new files
	const treeItems = await Promise.all(
		files.map(async (file) => {
			const blobResponse = await octokit.git.createBlob({
				owner,
				repo,
				content: file.content,
				encoding: "utf-8",
			});
			return {
				path: file.path,
				mode: "100644" as const,
				type: "blob" as const,
				sha: blobResponse.data.sha,
			};
		})
	);

	// 4. Create a new tree
	const treeResponse = await octokit.git.createTree({
		owner,
		repo,
		base_tree: baseTreeSha,
		tree: treeItems,
	});

	// 5. Create a new commit
	const newCommitResponse = await octokit.git.createCommit({
		owner,
		repo,
		message,
		tree: treeResponse.data.sha,
		parents: [latestCommitSha],
	});

	// 6. Update the branch reference
	await octokit.git.updateRef({
		owner,
		repo,
		ref: `heads/${branch}`,
		sha: newCommitResponse.data.sha,
	});

	return newCommitResponse.data.sha;
}
