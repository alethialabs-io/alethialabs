// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which apps repos GitOps add-on delivery can write to (#6599).
//
// GitOps delivery seeds `addons/<id>.yaml` into the environment's apps repo and pushes it. The runner
// pushes with the job owner's linked OAuth token, and only the GitHub link holds a scope that can
// push: the GitLab link asks for `read_repository` and the Bitbucket link for `repository`, both
// read-only. Those scopes are left as they are on purpose (the decision is recorded on #6599):
// widening them would grant write access to every account that links GitLab or Bitbucket, used or
// not. So the console refuses GitOps delivery for an apps repo on any provider but GitHub, once when
// the mode is chosen and again before a deploy is queued, instead of letting the deploy fail on a
// push it could never make.

import type { GitProvider } from "@/lib/db/schema";
import { configuredGitProviderHosts } from "@/lib/git/configured-hosts";
import { type GitProviderHosts, resolveGitProvider } from "@/lib/git/provider-host";

/** The display name of each git provider, as the console's sentences spell it. */
const PROVIDER_NAMES: Readonly<Record<GitProvider, string>> = {
	github: "GitHub",
	gitlab: "GitLab",
	bitbucket: "Bitbucket",
};

/** The providers whose linked token can push to an apps repo. GitHub only, for now. */
const PUSH_CAPABLE: ReadonlySet<GitProvider> = new Set<GitProvider>(["github"]);

/**
 * Why GitOps delivery cannot write to `appsRepo`, as the sentence the console shows, or null when it
 * can. The provider is resolved by {@link resolveGitProvider} from the repo's exact host, never by a
 * substring match. A repo on GitHub is allowed. A repo on GitLab or Bitbucket is refused because the
 * linked token cannot push, and a repo whose host matches no configured provider is refused because
 * no token is issued for it at all. An environment with no apps repo answers null: GitOps delivery
 * then writes nothing, and the add-on card already says the mode needs an apps repo.
 */
export function gitopsModeRefusal(
	appsRepo: string | null | undefined,
	hosts: GitProviderHosts = configuredGitProviderHosts(),
): string | null {
	if (!appsRepo || !appsRepo.trim()) return null;
	const resolved = resolveGitProvider(appsRepo, hosts);
	if (!resolved.ok) {
		return (
			"GitOps delivery works only with an apps repository on GitHub for now. Alethia cannot tell " +
			"which Git provider hosts this environment's apps repository, so it cannot push an add-on " +
			"manifest there. Use Managed delivery instead."
		);
	}
	if (PUSH_CAPABLE.has(resolved.provider)) return null;
	const name = PROVIDER_NAMES[resolved.provider];
	return (
		`GitOps delivery works only with an apps repository on GitHub for now. This environment's apps ` +
		`repository is on ${name}, and Alethia's ${name} connection can read repositories but cannot ` +
		"push to them. Use Managed delivery instead."
	);
}

/** The parts of a DEPLOY config snapshot that {@link gitopsDeployRefusal} reads. */
export interface GitopsDeploySnapshot {
	repositories?: { apps_destination_repo?: string | null } | null;
	addons?: ReadonlyArray<{ id: string; mode?: string | null }> | null;
}

/**
 * Why a deploy of `snapshot` must not be queued, or null when it may. It is refused when the
 * snapshot carries at least one GitOps-mode add-on and its apps repo is one {@link gitopsModeRefusal}
 * refuses. This is the second check: an add-on chosen as GitOps while the apps repo was on GitHub
 * stays GitOps when the repo later moves, and the deploy is where that is caught. The sentence names
 * the add-ons so the person knows which ones to switch.
 */
export function gitopsDeployRefusal(
	snapshot: GitopsDeploySnapshot,
	hosts?: GitProviderHosts,
): string | null {
	const gitops = (snapshot.addons ?? []).filter((a) => a.mode === "gitops").map((a) => a.id);
	if (gitops.length === 0) return null;
	const refusal = gitopsModeRefusal(snapshot.repositories?.apps_destination_repo, hosts);
	if (!refusal) return null;
	const which = gitops.length === 1 ? "add-on" : "add-ons";
	return `${refusal} Switch the GitOps ${which} ${gitops.join(", ")} to Managed delivery, then deploy again.`;
}
