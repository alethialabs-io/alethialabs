// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alethia GitHub App, as one typed definition.
//
// A GitHub App is registered once per control plane: the hosted console has one, and every
// self-hosted console registers its own against github.com, because the webhook URL is that
// deployment's. Both are built from THIS file — the hosted App is registered by the maintainer
// with these values, and a self-hosted one through GitHub's manifest flow, which takes the object
// `buildGitHubAppManifest` returns. GitHub Enterprise Server is not offered: the only host named
// here is github.com.
//
// WHY THE PERMISSION SET IS PINNED BY A TEST (tests/lib/git/github-app/manifest.test.ts).
// A permission added after people have installed the App is not granted until the owner of each
// installing account approves it, and until then that installation keeps the old set. So the set
// has to be complete on the first public install, and a change to it is a decision, not an edit:
// the test fails on any difference, in either direction.
//
// This file is pure. It makes no network call, registers nothing and reads no configuration.
//
// Sources (GitHub Docs, read 2026-11-17):
//   manifest flow and its fields — https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
//   permission names and what each endpoint needs — https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
//   what each event needs, and which arrive unasked — https://docs.github.com/en/webhooks/webhook-events-and-payloads
//   approval of added permissions — https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration
//   setup URL versus authorization on install — https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app

// ── Permissions ───────────────────────────────────────────────────────────────────────────

/**
 * Every permission the App requests, under the name GitHub's manifest uses. All five are
 * repository permissions; the App requests no organization and no account permission.
 *
 * Nothing is here that the pull-request loop does not use. Deliberately absent, each for a reason:
 * `workflows` (without it the App cannot write under `.github/workflows`), `administration` (what
 * `GET …/branches/{branch}/protection` needs — see `metadata` below for what is used instead), `issues` (comments on a pull request are covered by `pull_requests`), `statuses`,
 * `members` and `repository_hooks`.
 */
export const GITHUB_APP_PERMISSIONS = {
	// Repository identity: `GET /repos/{owner}/{repo}` for the default branch and visibility, and
	// `GET /repos/{owner}/{repo}/rules/branches/{branch}` for the rules that apply to the design
	// branch. Together with `GET …/branches/{branch}` (under `contents`) that is everything the App
	// can ask about branch protection; where it does not settle the question the answer is
	// "unknown", never a request for `administration`.
	metadata: "read",
	// Read the design file and the scanned sources (`GET …/contents/{path}`, git blobs, a clone
	// with the installation token), create the change branch (`POST …/git/refs`) and commit
	// `alethia.yaml` to it (`PUT …/contents/{path}`). Also what the `push` event requires.
	contents: "write",
	// Open and update the proposal and change pull requests (`POST`/`PATCH …/pulls`) and keep the
	// one summary comment current (`POST …/issues/{n}/comments`, `PATCH …/issues/comments/{id}`,
	// which GitHub accepts under this permission). Also what the `pull_request` event requires.
	pull_requests: "write",
	// Create and update the plan check (`POST`/`PATCH …/check-runs`). Write, not read, is also what
	// delivers the `rerequested` and `requested_action` actions of the `check_run` event.
	checks: "write",
	// Record each apply as a deployment with a final status (`POST …/deployments`,
	// `POST …/deployments/{id}/statuses`). Requested from the first install on purpose, so that
	// turning deployments on later needs nobody's re-approval.
	deployments: "write",
} as const;

/** A permission the App requests. */
export type GitHubAppPermission = keyof typeof GITHUB_APP_PERMISSIONS;

/**
 * Why each permission is requested, in words an installer can read. Shown beside the permission
 * wherever the set is listed before someone creates or installs the App. One entry per permission,
 * enforced by the type.
 */
export const GITHUB_APP_PERMISSION_REASONS: Record<GitHubAppPermission, string> = {
	metadata: "Identify the repository, its default branch and the rules on the design branch.",
	contents:
		"Read alethia.yaml and the sources a scan reads, and commit alethia.yaml to a branch for a pull request.",
	pull_requests: "Open and update pull requests that change alethia.yaml, and keep one summary comment current.",
	checks: "Report the plan for a pull request as a check, and re-run it when asked.",
	deployments: "Record each apply as a deployment on the repository.",
};

// ── Events ────────────────────────────────────────────────────────────────────────────────

/**
 * The events the App subscribes to. `push` syncs a merged design and can start a re-scan;
 * `pull_request` starts a plan; `check_run` carries a request to re-run one.
 */
export const GITHUB_APP_EVENTS = ["push", "pull_request", "check_run"] as const;

/** An event the App subscribes to. */
export type GitHubAppEvent = (typeof GITHUB_APP_EVENTS)[number];

/**
 * The permission GitHub requires before an App may subscribe to each event. Every one must be in
 * {@link GITHUB_APP_PERMISSIONS}; the type makes a missing one a compile error.
 */
export const GITHUB_APP_EVENT_PERMISSION: Record<GitHubAppEvent, GitHubAppPermission> = {
	push: "contents",
	pull_request: "pull_requests",
	check_run: "checks",
};

/**
 * Events GitHub delivers to every App without a subscription, and which a manifest therefore must
 * not list: an installation created, removed or suspended; repositories added to or removed from
 * one; a user revoking their authorization. The webhook handler has to expect them all the same.
 */
export const GITHUB_APP_UNSUBSCRIBED_EVENTS = [
	"installation",
	"installation_repositories",
	"github_app_authorization",
] as const;

// ── Routes the App points at ──────────────────────────────────────────────────────────────

/**
 * The console paths GitHub is told about. They are part of the App's registration: once an App
 * exists, moving a route means editing every registered App, so the routes are created AT these
 * paths and not the other way round.
 *
 *   - `webhook`          — receives every delivery.
 *   - `installCallback`  — where a person lands after installing and authorizing the App.
 *   - `manifestRedirect` — where GitHub returns the one-time code after a self-hosted console's
 *                          App is created from the manifest.
 */
export const GITHUB_APP_PATHS = {
	webhook: "/api/webhooks/github",
	installCallback: "/api/git/github/callback",
	manifestRedirect: "/api/git/app-registration/callback",
} as const;

// ── The manifest ──────────────────────────────────────────────────────────────────────────

/**
 * The manifest GitHub accepts, limited to the fields this App sets.
 *
 * `setup_url` and `setup_on_update` are left out on purpose: the App asks for the installer's
 * authorization during installation (`request_oauth_on_install`), and GitHub then sends the person
 * to a callback URL rather than to a setup URL.
 */
export interface GitHubAppManifest {
	/** The App's name. Left out, the person registering it names it on GitHub. */
	name?: string;
	/** The App's homepage: the console. */
	url: string;
	hook_attributes: { url: string; active: boolean };
	redirect_url: string;
	callback_urls: string[];
	description: string;
	public: boolean;
	default_permissions: typeof GITHUB_APP_PERMISSIONS;
	default_events: readonly GitHubAppEvent[];
	request_oauth_on_install: boolean;
}

/** The description GitHub shows on the App's page and on its install screen. */
export const GITHUB_APP_DESCRIPTION =
	"Alethia plans every pull request that changes alethia.yaml, reports the plan as a check, and applies the design after the pull request is merged.";

/**
 * Who the App is for. The hosted App is installed by any account, so it is public; a self-hosted
 * console's App belongs to the account that runs that console and is installable only by it.
 */
export type GitHubAppAudience = "hosted" | "self_hosted";

/** What varies between one control plane's App and another's. */
export interface GitHubAppManifestInput {
	/** The console's public origin, e.g. `https://console.example.com`. */
	consoleUrl: string;
	audience: GitHubAppAudience;
	name?: string;
}

/**
 * Why a manifest was not built: the console URL is not a URL, is not `https` (GitHub has to reach
 * the webhook over it), or is more than an origin (it carries a path, a query, a fragment or
 * credentials, any of which would end up inside every URL the App is registered with).
 */
export type GitHubAppManifestRefusal = "invalid_url" | "not_https" | "not_an_origin";

/** The outcome of {@link buildGitHubAppManifest}. */
export type GitHubAppManifestResult =
	| { ok: true; manifest: GitHubAppManifest }
	| { ok: false; reason: GitHubAppManifestRefusal };

/** Parses an absolute URL, or returns null when the text is not one. */
function parseUrl(text: string): URL | null {
	try {
		return new URL(text);
	} catch {
		return null;
	}
}

/**
 * Builds the manifest for one control plane. The permissions, the events and the paths are the
 * constants above for every caller; only the origin, the audience and the name differ.
 */
export function buildGitHubAppManifest(input: GitHubAppManifestInput): GitHubAppManifestResult {
	const origin = parseUrl(input.consoleUrl);
	if (origin === null) return { ok: false, reason: "invalid_url" };
	if (origin.protocol !== "https:") return { ok: false, reason: "not_https" };
	if (
		origin.pathname !== "/" ||
		origin.search !== "" ||
		origin.hash !== "" ||
		origin.username !== "" ||
		origin.password !== ""
	) {
		return { ok: false, reason: "not_an_origin" };
	}
	const at = (path: string) => new URL(path, origin).toString();
	const manifest: GitHubAppManifest = {
		url: origin.origin,
		hook_attributes: { url: at(GITHUB_APP_PATHS.webhook), active: true },
		redirect_url: at(GITHUB_APP_PATHS.manifestRedirect),
		callback_urls: [at(GITHUB_APP_PATHS.installCallback)],
		description: GITHUB_APP_DESCRIPTION,
		public: input.audience === "hosted",
		default_permissions: GITHUB_APP_PERMISSIONS,
		default_events: GITHUB_APP_EVENTS,
		request_oauth_on_install: true,
	};
	const name = input.name?.trim();
	return { ok: true, manifest: name ? { name, ...manifest } : manifest };
}

// ── Where the manifest is sent ────────────────────────────────────────────────────────────

/** The account a self-hosted console's App is registered under. */
export type GitHubAppOwner = { kind: "personal" } | { kind: "organization"; login: string };

/**
 * The characters an account login may be made of here: letters, digits, hyphens and underscores.
 * This is not GitHub's own rule for a login — it is the set that cannot turn one path segment into
 * two or add a query, which is all this file needs from it. GitHub decides whether the account exists.
 */
const PATH_SAFE_LOGIN = /^[A-Za-z0-9_-]+$/;

/**
 * The github.com URL a manifest is POSTed to, carrying the `state` GitHub hands back with the
 * one-time code. Returns null for an organization login outside {@link PATH_SAFE_LOGIN}, or an
 * empty `state` — a caller must not send a manifest anywhere in either case.
 */
export function gitHubAppRegistrationUrl(owner: GitHubAppOwner, state: string): string | null {
	if (state === "") return null;
	let path = "/settings/apps/new";
	if (owner.kind === "organization") {
		if (!PATH_SAFE_LOGIN.test(owner.login)) return null;
		path = `/organizations/${owner.login}/settings/apps/new`;
	}
	const url = new URL(path, "https://github.com");
	url.searchParams.set("state", state);
	return url.toString();
}
