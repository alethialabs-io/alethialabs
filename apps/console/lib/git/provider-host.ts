// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getGitlabBaseUrl } from "@/lib/config/auth";
import type { GitProvider } from "@/lib/db/schema";

/**
 * Why a repository URL could not be tied to a git provider. Each is a refusal: no caller may fall
 * back to a default provider, because the provider decides whose token is handed out for the repo.
 */
export type GitProviderRefusal =
	| "empty"
	| "malformed"
	| "unsupported_scheme"
	| "unknown_host";

/** The result of {@link resolveGitProvider}. */
export type GitProviderResolution =
	| { ok: true; provider: GitProvider; host: string }
	| { ok: false; reason: GitProviderRefusal; host: string | null };

/** The hosts each provider is configured at. Only `gitlabBaseUrl` is configurable today. */
export interface GitProviderHosts {
	/** Base URL of the GitLab instance the console's GitLab sign-in is wired to. */
	gitlabBaseUrl: string;
}

/** The two providers whose host is fixed: there is no self-hosted GitHub or Bitbucket config. */
const FIXED_HOSTS: ReadonlyMap<string, GitProvider> = new Map([
	["github.com", "github"],
	["bitbucket.org", "bitbucket"],
]);

/**
 * An scp-style git remote, `user@host:path` — the `git@…` form the BYO IaC and BYO chart validators
 * accept. The host may not contain a `/`, `:` or `@`, and the path must not start with `//` (that is
 * a URL). Excluding `@` keeps a second `user@` segment from being read as part of the host.
 */
const SCP_REMOTE = /^[^@\s/]+@([^:\s/@]+):(?!\/\/)\S+$/;

/**
 * The shape of a host this module will name: dot-separated labels of letters, digits, `-` and `_`,
 * or a bracketed IPv6 literal. A host outside it is refused as malformed, so the host a refusal or a
 * log line reports is always a plain hostname and never other text from the remote.
 */
const HOST_SHAPE = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/;

/** What a log line or an error body says in place of a host that could not be read from a repo URL. */
export const UNPARSED_REPO_HOST = "(unparsed repo URL)";

/**
 * Printable ASCII with no backslash or whitespace. The URL parser here reads a backslash as `/` and folds
 * Unicode hosts, while the git client that later uses the token may not, so a remote outside this set
 * could name one host to this check and another to the clone. Real remotes never need such characters.
 */
const PLAIN_REMOTE = /^[!-[\]-~]+$/;

/**
 * An accepted URL remote must spell `scheme://host` literally. The URL parser here repairs
 * `https:/host`, `https:host` and `https:///host` into `https://host`, but the runner's git client
 * does not, so a remote it would have to repair could name one host here and another at clone time.
 */
const LITERAL_AUTHORITY = /^(?:https|ssh):\/\/[^/]/i;

/** URL schemes a git remote may use here. Plain `http:` is refused: a token must not cross it. */
const ALLOWED_SCHEMES = new Set(["https:", "ssh:"]);

/** Returns the lowercased hostname of a URL, or null when it does not parse. */
function hostnameOf(rawUrl: string): string | null {
	try {
		return new URL(rawUrl).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/** Extracts the lowercased host of a git remote, or a refusal when it has none we can trust. */
function remoteHost(
	repoUrl: string,
): { ok: true; host: string } | { ok: false; reason: GitProviderRefusal } {
	if (!PLAIN_REMOTE.test(repoUrl)) return { ok: false, reason: "malformed" };
	const scp = SCP_REMOTE.exec(repoUrl);
	if (scp) return shapedHost(scp[1]);

	let url: URL;
	try {
		url = new URL(repoUrl);
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (!ALLOWED_SCHEMES.has(url.protocol)) {
		return { ok: false, reason: "unsupported_scheme" };
	}
	if (!LITERAL_AUTHORITY.test(repoUrl)) return { ok: false, reason: "malformed" };
	return shapedHost(url.hostname);
}

/** Lowercases a host read from a remote, refusing it as malformed when it is not hostname-shaped. */
function shapedHost(
	rawHost: string,
): { ok: true; host: string } | { ok: false; reason: GitProviderRefusal } {
	const host = rawHost.toLowerCase();
	if (!HOST_SHAPE.test(host)) return { ok: false, reason: "malformed" };
	return { ok: true, host };
}

/**
 * Works out which git provider owns a repository URL, by an EXACT match of its hostname against the
 * hosts the console is configured for:
 *
 * - `github.com` is GitHub and `bitbucket.org` is Bitbucket. Neither has a self-hosted config.
 * - GitLab is the host of `GITLAB_BASE_URL` (see `getGitlabBaseUrl`), which defaults to
 *   `gitlab.com`. When a self-hosted GitLab is configured, `gitlab.com` itself does NOT match: the
 *   linked GitLab account and its token belong to the configured instance, not to gitlab.com.
 *
 * There is no suffix or subdomain matching, so `evilgithub.com`, `github.com.evil.io` and
 * `api.github.com` are all refused. The comparison ignores case and the port. Accepted forms are
 * `https://` and `ssh://` URLs and scp-style `git@host:owner/repo` remotes; anything else, and any
 * host that matches nothing, is refused rather than defaulted. A remote containing a backslash,
 * whitespace or a non-ASCII character, a URL that does not spell `scheme://host` literally, and a
 * host that is not hostname-shaped are refused as malformed. A refusal therefore only ever reports a
 * plain hostname, or `null` when none could be read.
 */
export function resolveGitProvider(
	repoUrl: string,
	hosts: GitProviderHosts = { gitlabBaseUrl: getGitlabBaseUrl() },
): GitProviderResolution {
	const trimmed = repoUrl.trim();
	if (!trimmed) return { ok: false, reason: "empty", host: null };

	const remote = remoteHost(trimmed);
	if (!remote.ok) return { ok: false, reason: remote.reason, host: null };
	const { host } = remote;

	const fixed = FIXED_HOSTS.get(host);
	if (fixed) return { ok: true, provider: fixed, host };

	const gitlabHost = hostnameOf(hosts.gitlabBaseUrl);
	if (gitlabHost && host === gitlabHost) {
		return { ok: true, provider: "gitlab", host };
	}

	return { ok: false, reason: "unknown_host", host };
}

/**
 * The host a repo URL names, for a log line: never the full URL, which can carry credentials in its
 * userinfo. Returns a placeholder when the URL has no host this module can read.
 */
export function repoHostForLog(repoUrl: string): string {
	const remote = remoteHost(repoUrl.trim());
	return remote.ok ? remote.host : UNPARSED_REPO_HOST;
}
