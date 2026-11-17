// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins the GitHub App's registration (lib/git/github-app/manifest.ts).
//
// THE PERMISSION AND EVENT SETS ARE WRITTEN OUT A SECOND TIME HERE ON PURPOSE. A permission added
// after the App has installers is not granted until each installing account's owner approves it,
// and one removed silently breaks the call that used it — so a change to either set has to be made
// twice, deliberately, and show up in review as two diffs. Deriving the expectation from the
// constant under test would make this file agree with any edit.
//
// Boundary, stated: this pins what the console SENDS. Whether GitHub accepts each name is decided
// by GitHub when an App is registered from the manifest, which no unit test can stand in for.

import { describe, expect, it } from "vitest";
import {
	buildGitHubAppManifest,
	type GitHubAppManifest,
	type GitHubAppManifestInput,
	GITHUB_APP_DESCRIPTION,
	GITHUB_APP_EVENT_PERMISSION,
	GITHUB_APP_EVENTS,
	GITHUB_APP_PATHS,
	GITHUB_APP_PERMISSION_REASONS,
	GITHUB_APP_PERMISSIONS,
	GITHUB_APP_UNSUBSCRIBED_EVENTS,
	gitHubAppRegistrationUrl,
} from "@/lib/git/github-app/manifest";

/** Builds a manifest and fails the test when the input was refused. */
function manifestFor(input: GitHubAppManifestInput): GitHubAppManifest {
	const built = buildGitHubAppManifest(input);
	if (!built.ok) throw new Error(`expected a manifest, was refused: ${built.reason}`);
	return built.manifest;
}

const CONSOLE = "https://console.acme.example";

describe("the permission set", () => {
	it("is exactly these five repository permissions at these levels", () => {
		expect(GITHUB_APP_PERMISSIONS).toStrictEqual({
			metadata: "read",
			contents: "write",
			pull_requests: "write",
			checks: "write",
			deployments: "write",
		});
	});

	it.each([
		"administration",
		"workflows",
		"issues",
		"statuses",
		"members",
		"repository_hooks",
		"organization_hooks",
		"secrets",
		"actions",
	])("does not request %s", (permission) => {
		expect(Object.keys(GITHUB_APP_PERMISSIONS)).not.toContain(permission);
	});

	it("gives a reason for every permission, and for nothing else", () => {
		expect(Object.keys(GITHUB_APP_PERMISSION_REASONS).sort()).toEqual(Object.keys(GITHUB_APP_PERMISSIONS).sort());
		for (const reason of Object.values(GITHUB_APP_PERMISSION_REASONS)) {
			expect(reason.trim().length).toBeGreaterThan(20);
		}
	});
});

describe("the event set", () => {
	it("subscribes to exactly these three events", () => {
		expect([...GITHUB_APP_EVENTS]).toStrictEqual(["push", "pull_request", "check_run"]);
	});

	it("holds the permission each subscribed event requires", () => {
		expect(GITHUB_APP_EVENT_PERMISSION).toStrictEqual({
			push: "contents",
			pull_request: "pull_requests",
			check_run: "checks",
		});
		for (const permission of Object.values(GITHUB_APP_EVENT_PERMISSION)) {
			expect(Object.keys(GITHUB_APP_PERMISSIONS)).toContain(permission);
		}
	});

	it("does not subscribe to an event GitHub delivers unasked", () => {
		expect([...GITHUB_APP_UNSUBSCRIBED_EVENTS]).toStrictEqual([
			"installation",
			"installation_repositories",
			"github_app_authorization",
		]);
		const subscribed: readonly string[] = GITHUB_APP_EVENTS;
		for (const event of GITHUB_APP_UNSUBSCRIBED_EVENTS) {
			expect(subscribed).not.toContain(event);
		}
	});
});

describe("the paths the App is registered with", () => {
	it("are these three", () => {
		expect(GITHUB_APP_PATHS).toStrictEqual({
			webhook: "/api/webhooks/github",
			installCallback: "/api/git/github/callback",
			manifestRedirect: "/api/git/app-registration/callback",
		});
	});
});

describe("buildGitHubAppManifest", () => {
	it("builds the whole manifest for a self-hosted console", () => {
		const built = buildGitHubAppManifest({
			consoleUrl: "https://console.acme.example",
			audience: "self_hosted",
			name: "  alethia-acme  ",
		});
		expect(built).toStrictEqual({
			ok: true,
			manifest: {
				name: "alethia-acme",
				url: "https://console.acme.example",
				hook_attributes: { url: "https://console.acme.example/api/webhooks/github", active: true },
				redirect_url: "https://console.acme.example/api/git/app-registration/callback",
				callback_urls: ["https://console.acme.example/api/git/github/callback"],
				description: GITHUB_APP_DESCRIPTION,
				public: false,
				default_permissions: {
					metadata: "read",
					contents: "write",
					pull_requests: "write",
					checks: "write",
					deployments: "write",
				},
				default_events: ["push", "pull_request", "check_run"],
				request_oauth_on_install: true,
			},
		});
	});

	it("makes the hosted App public and differs from a self-hosted one in nothing else", () => {
		const hosted = manifestFor({ consoleUrl: CONSOLE, audience: "hosted" });
		const selfHosted = manifestFor({ consoleUrl: CONSOLE, audience: "self_hosted" });
		expect(hosted.public).toBe(true);
		expect(selfHosted.public).toBe(false);
		expect({ ...hosted, public: false }).toStrictEqual(selfHosted);
	});

	it.each([[undefined], [""], ["   "]])("leaves the name to the person registering when it is %j", (name) => {
		expect(Object.keys(manifestFor({ consoleUrl: CONSOLE, audience: "hosted", name }))).not.toContain("name");
	});

	it("never sets a setup URL, because authorization on install replaces it", () => {
		const keys = Object.keys(manifestFor({ consoleUrl: CONSOLE, audience: "hosted" }));
		expect(keys).toContain("request_oauth_on_install");
		expect(keys).not.toContain("setup_url");
		expect(keys).not.toContain("setup_on_update");
	});

	it("keeps a port and drops a trailing slash", () => {
		const built = buildGitHubAppManifest({ consoleUrl: "https://console.acme.example:8443/", audience: "self_hosted" });
		expect(built).toMatchObject({
			ok: true,
			manifest: {
				url: "https://console.acme.example:8443",
				hook_attributes: { url: "https://console.acme.example:8443/api/webhooks/github" },
			},
		});
	});

	it("serialises to JSON with the permission and event names GitHub reads", () => {
		const json: unknown = JSON.parse(JSON.stringify(manifestFor({ consoleUrl: CONSOLE, audience: "hosted" })));
		expect(json).toMatchObject({
			default_permissions: { deployments: "write" },
			default_events: ["push", "pull_request", "check_run"],
		});
	});

	it.each([
		["not a url", "invalid_url"],
		["", "invalid_url"],
		["console.acme.example", "invalid_url"],
		["http://console.acme.example", "not_https"],
		["ftp://console.acme.example", "not_https"],
		["https://console.acme.example/console", "not_an_origin"],
		["https://console.acme.example/?next=1", "not_an_origin"],
		["https://console.acme.example/#top", "not_an_origin"],
		["https://user@console.acme.example", "not_an_origin"],
		["https://user:pw@console.acme.example", "not_an_origin"],
	])("refuses %j as %s", (consoleUrl, reason) => {
		expect(buildGitHubAppManifest({ consoleUrl, audience: "self_hosted" })).toStrictEqual({ ok: false, reason });
	});
});

describe("gitHubAppRegistrationUrl", () => {
	it("targets the personal account's settings", () => {
		expect(gitHubAppRegistrationUrl({ kind: "personal" }, "s3")).toBe("https://github.com/settings/apps/new?state=s3");
	});

	it("targets an organization's settings", () => {
		expect(gitHubAppRegistrationUrl({ kind: "organization", login: "acme-labs" }, "s3")).toBe(
			"https://github.com/organizations/acme-labs/settings/apps/new?state=s3",
		);
	});

	it("encodes the state", () => {
		expect(gitHubAppRegistrationUrl({ kind: "personal" }, "a b&c=d")).toBe(
			"https://github.com/settings/apps/new?state=a+b%26c%3Dd",
		);
	});

	it.each([[""], ["acme/evil"], ["acme?x=1"], ["../settings"], ["acme labs"], ["acme#x"], ["acme%2F"]])(
		"refuses the organization login %j",
		(login) => {
			expect(gitHubAppRegistrationUrl({ kind: "organization", login }, "s3")).toBeNull();
		},
	);

	it("refuses an empty state for either owner", () => {
		expect(gitHubAppRegistrationUrl({ kind: "personal" }, "")).toBeNull();
		expect(gitHubAppRegistrationUrl({ kind: "organization", login: "acme" }, "")).toBeNull();
	});
});
