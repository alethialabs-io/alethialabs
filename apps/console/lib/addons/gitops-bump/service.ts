// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console side of the GitOps add-on bump pull request (#6549): resolve the environment's apps
// repo and add-on, fetch the CLICKING user's own GitHub token server-side, run the flow
// (open-bump.ts), and record the pull request on the add-on's row so the Deploy tab and the card
// can link to it.
//
// The token is the user's, so the pull request is opened under the name and with the repository
// permission of the person who asked, never under whoever last pressed Deploy. It is read here, used
// for the GitHub calls, and dropped: it is not returned, logged, or stored. Only the pull request's
// number, URL, branch and state are stored.
//
// The caller has already authorised the actor for `edit` on the project; this function trusts that
// and scopes every read and write to the project, environment and org it was handed. It does NOT
// trust that the actor is a person: a pull request is opened with a person's own GitHub account, so
// an actor with no personal identity (`personalIdentityAuthor`, lib/authz/actor-credential.ts) is
// refused before any token is read.

import "server-only";
import { and, eq } from "drizzle-orm";
import { getAddOn } from "@/lib/addons/catalog";
import { providerTokenForUser } from "@/lib/auth/provider-token";
import { personalIdentityAuthor } from "@/lib/authz/actor-credential";
import type { Actor } from "@/lib/authz/types";
import type { Tx } from "@/lib/db";
import { projectAddons, projectRepositories } from "@/lib/db/schema";
import type { GitopsBumpRecord } from "@/types/jsonb.types";
import type { BumpEditRefusal } from "./edit";
import { configuredGitProviderHosts } from "@/lib/git/configured-hosts";
import { resolveGitProvider } from "@/lib/git/provider-host";
import { type FetchLike, githubClient, githubRepoFromUrl } from "./github";
import { type BumpOutcome, openGitopsBump } from "./open-bump";

/** Why no pull request was opened. Each comes with the manual instruction. */
export type GitopsBumpRefusalReason =
	| "not-a-person"
	| "not-installed"
	| "not-gitops"
	| "not-catalog"
	| "no-apps-repo"
	| "provider-not-supported"
	| "unknown-host"
	| "no-git-link"
	| "no-file"
	| "not-bumpable"
	| "branch-diverged"
	| "token-rejected"
	| "no-permission"
	| "github-error";

/** The outcome the console card, the Deploy tab and the CLI all render. */
export type GitopsBumpResult =
	| {
			status: "open" | "merged" | "declined";
			/** True only when this call opened the pull request. */
			created: boolean;
			version: string;
			number: number;
			url: string;
			/** The file and field the pull request changes. */
			file: string;
			field: "spec.source.targetRevision";
	  }
	| {
			status: "refused";
			reason: GitopsBumpRefusalReason;
			/** A sentence for the person: what happened and what to do instead. No provider text. */
			message: string;
			/** The manual instruction, always: the file and field to change, and the version. */
			file: string;
			field: "spec.source.targetRevision";
			version: string;
	  };

/** What is being asked for. */
export interface GitopsBumpInput {
	/** Who asked. Only a person's own GitHub account opens the pull request; see the file comment. */
	actor: Actor;
	projectId: string;
	environmentId: string;
	addonId: string;
	/** The user explicitly asked again after closing the last pull request for this version. */
	again: boolean;
}

/** The sentence for an edit refusal: the file is not one Alethia can be sure it may change. */
function editRefusalMessage(r: BumpEditRefusal): string {
	switch (r) {
		case "not-older":
			return "The file already installs this version or a newer one, so there is nothing to change.";
		case "different-chart":
			return "The file installs a different chart from the one Alethia seeded, so Alethia will not change it.";
		case "revision-not-semver":
			return "The file's chart version is not a single version (a range, or a shortened one), which is your choice to keep.";
		default:
			return "The file is no longer in the shape Alethia seeded, so Alethia cannot be sure the change is the only one it makes.";
	}
}

/** Maps a flow outcome to the result, given the version it was for. */
function toResult(outcome: BumpOutcome, version: string, file: string): GitopsBumpResult {
	const refused = (reason: GitopsBumpRefusalReason, message: string): GitopsBumpResult => ({
		status: "refused",
		reason,
		message,
		file,
		field: "spec.source.targetRevision",
		version,
	});
	const pulled = (status: "open" | "merged" | "declined", created: boolean, pull: { number: number; url: string }): GitopsBumpResult => ({
		status,
		created,
		version,
		number: pull.number,
		url: pull.url,
		file,
		field: "spec.source.targetRevision",
	});
	switch (outcome.kind) {
		case "opened":
		case "existing":
			return pulled("open", outcome.kind === "opened", outcome.pull);
		case "merged":
			return pulled("merged", false, outcome.pull);
		case "declined":
			return pulled("declined", false, outcome.pull);
		case "no-file":
			return refused("no-file", "The apps repo has no such file on its default branch. The next deploy seeds it at the catalog's version.");
		case "not-bumpable":
			return refused("not-bumpable", editRefusalMessage(outcome.refusal));
		case "branch-diverged":
			return refused(
				"branch-diverged",
				`The branch ${outcome.branch} already exists in the apps repo and does not hold exactly this change, so Alethia will not reuse it. Delete the branch to try again.`,
			);
		case "invalid-input":
			return refused("not-catalog", "This add-on's id or version cannot name a branch.");
		case "github-error":
			if (outcome.status === 401) {
				return refused("token-rejected", "GitHub did not accept your linked account's token. Reconnect GitHub, then try again.");
			}
			if (outcome.status === 403 || outcome.status === 404) {
				return refused(
					"no-permission",
					"Your GitHub account cannot write to the apps repo, or the repo's organization does not allow Alethia's GitHub app.",
				);
			}
			return refused("github-error", `GitHub could not ${outcome.operation} (HTTP ${outcome.status || "error"}).`);
	}
}

/**
 * The record stored on the row for a result that names a pull request, or null for a refusal.
 * `opened_by` is the person whose click OPENED it: a pull request this call only found (open, merged
 * or declined) keeps the opener already recorded for it, and `userId` is used only when this call
 * opened it or there is no record of that pull request to keep.
 */
function toRecord(
	r: GitopsBumpResult,
	branch: string,
	userId: string,
	prior: GitopsBumpRecord | null,
	now: Date,
): GitopsBumpRecord | null {
	if (r.status === "refused") return null;
	const samePull = prior !== null && prior.number === r.number && prior.url === r.url;
	return {
		version: r.version,
		provider: "github",
		number: r.number,
		url: r.url,
		branch,
		state: r.status,
		opened_by: !r.created && samePull ? prior.opened_by : userId,
		updated_at: now.toISOString(),
	};
}

/** What the flow reads and writes in the database, behind one seam so it can be tested without one. */
export interface GitopsBumpStore {
	/**
	 * The add-on row (null when not installed), with the bump pull request already recorded on it, and
	 * the environment's apps repo (null when none).
	 */
	readTarget(input: GitopsBumpInput): Promise<{
		row: { mode: string; source: string; version: string | null; gitopsBump: GitopsBumpRecord | null } | null;
		appsRepo: string | null;
	}>;
	/** Records the pull request on the add-on's row. */
	saveBump(input: GitopsBumpInput, record: GitopsBumpRecord): Promise<void>;
}

/** The predicate for this add-on's row in this environment of this project. */
function addonRow(input: GitopsBumpInput) {
	return and(
		eq(projectAddons.project_id, input.projectId),
		eq(projectAddons.environment_id, input.environmentId),
		eq(projectAddons.addon_id, input.addonId),
	);
}

/**
 * The store over the caller's actor-scoped transactions (`scoped` is `withActorScope(actor, fn)`).
 * Each method is its own short transaction, so none is held open across the GitHub calls.
 */
export function actorScopedBumpStore(scoped: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>): GitopsBumpStore {
	return {
		readTarget: (input) =>
			scoped(async (tx) => {
				const [row] = await tx
					.select({
						mode: projectAddons.mode,
						source: projectAddons.source,
						version: projectAddons.version,
						gitopsBump: projectAddons.gitops_bump,
					})
					.from(projectAddons)
					.where(addonRow(input))
					.limit(1);
				const [repos] = await tx
					.select({ apps: projectRepositories.apps_destination_repo })
					.from(projectRepositories)
					.where(
						and(
							eq(projectRepositories.project_id, input.projectId),
							eq(projectRepositories.environment_id, input.environmentId),
						),
					)
					.limit(1);
				return { row: row ?? null, appsRepo: repos?.apps ?? null };
			}),
		saveBump: (input, record) =>
			scoped(async (tx) => {
				await tx.update(projectAddons).set({ gitops_bump: record }).where(addonRow(input));
			}),
	};
}

/** The token reader, a parameter so a test can see whether, and for which provider, it was asked. */
export type TokenReader = (userId: string, provider: "github") => Promise<string | null>;

/**
 * Opens (or finds) the bump pull request for one GitOps add-on in one environment and records it.
 * `store` reads and writes the database; the GitHub calls run between its two short transactions,
 * so none is held open across the network. `fetchImpl` and `readToken` are parameters for tests.
 */
export async function requestGitopsBumpFor(
	store: GitopsBumpStore,
	input: GitopsBumpInput,
	fetchImpl: FetchLike = fetch,
	readToken: TokenReader = providerTokenForUser,
	now: () => Date = () => new Date(),
): Promise<GitopsBumpResult> {
	const file = `addons/${input.addonId}.yaml`;
	const def = getAddOn(input.addonId);
	const { row, appsRepo } = await store.readTarget(input);
	const version = row?.version ?? def?.version ?? "";
	const refused = (reason: GitopsBumpRefusalReason, message: string): GitopsBumpResult => ({
		status: "refused",
		reason,
		message,
		file,
		field: "spec.source.targetRevision",
		version,
	});
	// A pull request is opened with a person's own GitHub account. An actor with no personal identity
	// (a service token pinned to a shared org, whose `userId` is only the profile that minted it) has
	// no account of its own to open one with, so it is refused here, before any token is read.
	const person = personalIdentityAuthor(input.actor);
	if (person === undefined) {
		return refused(
			"not-a-person",
			"A pull request is opened with a person's own GitHub account, and this credential is not a person's. Sign in as yourself (alethia login), or change the file yourself.",
		);
	}
	if (!row) return refused("not-installed", "This add-on is not enabled in this environment.");
	if (row.source !== "catalog" || !def) return refused("not-catalog", "Only a catalog add-on's seeded file can be bumped.");
	if (row.mode !== "gitops") return refused("not-gitops", "This add-on is managed by Alethia, so the next deploy installs its version.");
	if (!appsRepo) return refused("no-apps-repo", "This environment has no apps repo.");

	// The host decides where the token may go, BEFORE any token is read. `resolveGitProvider` is the
	// one exact-host resolver (github.com, bitbucket.org, the configured GitLab's host); an unknown
	// host, a non-https URL and a malformed one are refused there.
	const provider = resolveGitProvider(appsRepo, configuredGitProviderHosts());
	if (!provider.ok) {
		return refused("unknown-host", "Alethia does not recognise the apps repo's host, so it will not send a token there.");
	}
	if (provider.provider !== "github") {
		const name = provider.provider === "gitlab" ? "GitLab" : "Bitbucket";
		return refused("provider-not-supported", `Alethia opens these pull requests on GitHub only. On ${name}, change the file yourself.`);
	}
	const repo = githubRepoFromUrl(appsRepo);
	if (!repo) return refused("unknown-host", "The apps repo URL does not name a GitHub repository.");

	const token = await readToken(person, "github");
	if (!token) return refused("no-git-link", "Link your GitHub account to let Alethia open the pull request for you.");

	const outcome = await openGitopsBump(githubClient(repo, token, fetchImpl), {
		addonId: input.addonId,
		chart: def.chart,
		version,
		again: input.again,
		// The catalog's security note describes the CATALOG's version. A pin to another version is not
		// that release, so its pull request does not claim the fix.
		security:
			def.securityRelease && version === def.version
				? { summary: def.securityRelease.summary, advisoryUrl: def.securityRelease.advisoryUrl }
				: null,
	});
	const result = toResult(outcome, version, file);
	const record = "branch" in outcome ? toRecord(result, outcome.branch, person, row.gitopsBump, now()) : null;
	if (record) await store.saveBump(input, record);
	return result;
}
