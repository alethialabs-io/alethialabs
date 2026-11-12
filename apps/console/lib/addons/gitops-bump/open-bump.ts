// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Opening the pull request that moves a GitOps add-on's seeded chart version (#6549), or finding
// the one that already exists. Pure of the database and of auth: the caller hands in a GitHub
// client already bound to the user's token, and stores what this returns.
//
// One pull request per repository, add-on and version. The branch name is derived from those, so a
// second click, a second environment on the same repo, or a race between two clicks all land on the
// same branch, and the lookup by branch finds the pull request the first one opened. A pull request
// the user CLOSED without merging is a "no": it is reported, and nothing is written, unless the
// caller passes `again`, which is the user explicitly asking for it once more. A newer catalog
// version is a new branch, so it is offered afresh.
//
// Nothing here runs on a deploy. A deploy only reads the file and reports drift
// (packages/core/provisioner/addons_gitops.go); this runs when a user asks.

import { bumpTargetRevision, isStrictSemver, type BumpEditRefusal } from "./edit";
import { GithubCallError, type GithubClient, type GithubPull } from "./github";

/** A catalog add-on id: what the branch name and the file path are built from. */
const ADDON_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The deterministic head branch for one add-on and target version. */
export function bumpBranchName(addonId: string, version: string): string {
	return `alethia/addon-bump-${addonId}-${version}`;
}

/** What the flow did, or why it did nothing. */
export type BumpOutcome =
	| { kind: "opened" | "existing"; pull: GithubPull; branch: string; from: string | null }
	| { kind: "merged"; pull: GithubPull; branch: string }
	| { kind: "declined"; pull: GithubPull; branch: string }
	| { kind: "no-file" }
	| { kind: "branch-diverged"; branch: string }
	| { kind: "not-bumpable"; refusal: BumpEditRefusal }
	| { kind: "invalid-input" }
	| { kind: "github-error"; operation: string; status: number };

/** What the pull request is for. */
export interface BumpRequest {
	addonId: string;
	/** The catalog's chart, which the file must install. */
	chart: string;
	/** The version to move to: what a deploy would seed (the catalog's, or the user's pin). */
	version: string;
	/** True only when the user explicitly asked again after closing the last one. */
	again: boolean;
	/** The catalog's security-release summary and advisory link, when the version is one. */
	security: { summary: string; advisoryUrl: string } | null;
}

/** The pull request's title and body. Catalog facts only: no file content, values or URLs of ours. */
export function bumpPullText(req: BumpRequest, from: string): { title: string; body: string; commit: string } {
	const file = `addons/${req.addonId}.yaml`;
	const lines = [
		`This moves the GitOps add-on **${req.addonId}** from chart ${req.chart} ${from} to ${req.version}.`,
		"",
		`It changes one field, \`spec.source.targetRevision\` in \`${file}\`. The rest of the file is unchanged.`,
		"",
		"Values that the newer chart renamed or removed are not migrated. Check the chart's release notes before you merge.",
	];
	if (req.security) {
		lines.push("", `**Security release.** ${req.security.summary} Advisory: ${req.security.advisoryUrl}`);
	}
	lines.push("", "Opened from Alethia. If you close it without merging, Alethia does not open it again for this version.");
	return {
		title: `chore(addons): bump ${req.addonId} chart to ${req.version}`,
		body: lines.join("\n"),
		commit: `chore(addons): bump ${req.addonId} chart to ${req.version}`,
	};
}

/** Picks the pull request that decides the outcome: an open one, else a merged one, else the newest. */
function decisive(pulls: GithubPull[]): GithubPull | null {
	return (
		pulls.find((p) => p.state === "open") ??
		pulls.find((p) => p.merged) ??
		[...pulls].sort((a, b) => b.number - a.number)[0] ??
		null
	);
}

/** Byte equality. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Opens the bump pull request, or reports the one that exists. See the file comment. */
export async function openGitopsBump(gh: GithubClient, req: BumpRequest): Promise<BumpOutcome> {
	if (!ADDON_ID.test(req.addonId) || !isStrictSemver(req.version) || req.chart === "") {
		return { kind: "invalid-input" };
	}
	const branch = bumpBranchName(req.addonId, req.version);
	const path = `addons/${req.addonId}.yaml`;
	try {
		const prior = decisive(await gh.pullsFrom(branch));
		if (prior?.state === "open") return { kind: "existing", pull: prior, branch, from: null };
		if (prior?.merged) return { kind: "merged", pull: prior, branch };
		if (prior && !req.again) return { kind: "declined", pull: prior, branch };

		const base = await gh.defaultBranch();
		const file = await gh.readFile(path, base);
		if (!file) return { kind: "no-file" };
		const edit = bumpTargetRevision(file.bytes, req.chart, req.version);
		if (!edit.ok) return { kind: "not-bumpable", refusal: edit.refusal };
		const text = bumpPullText(req, edit.from);

		// The branch: create it at the default branch's head and commit the edit, or, when it already
		// exists (a previous attempt, a declined pull request, a concurrent click), use it only if it
		// already holds exactly this edit. A branch someone has pushed to is theirs.
		const head = await gh.branchHead(base);
		if (!head) return { kind: "github-error", operation: "read the default branch", status: 404 };
		const created = await gh.createBranch(branch, head);
		if (created) {
			await gh.writeFile(path, branch, edit.bytes, file.sha, text.commit);
		} else {
			const onBranch = await gh.readFile(path, branch);
			if (onBranch && sameBytes(onBranch.bytes, file.bytes)) {
				// The branch exists but the commit never landed (an earlier attempt failed between the
				// two calls): it still holds the default branch's file, so commit the edit onto it.
				await gh.writeFile(path, branch, edit.bytes, onBranch.sha, text.commit);
			} else if (!onBranch || !sameBytes(onBranch.bytes, edit.bytes)) {
				return { kind: "branch-diverged", branch };
			}
		}

		const pull = await gh.openPull({ title: text.title, body: text.body, head: branch, base });
		if (pull) return { kind: "opened", pull, branch, from: edit.from };
		// GitHub refused a duplicate: another click opened it first. Report that one.
		const raced = decisive(await gh.pullsFrom(branch));
		if (raced?.state === "open") return { kind: "existing", pull: raced, branch, from: edit.from };
		return { kind: "github-error", operation: "open the pull request", status: 422 };
	} catch (err) {
		if (err instanceof GithubCallError) return { kind: "github-error", operation: err.operation, status: err.status };
		throw err;
	}
}
