// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins how a repo URL is tied to a git provider (#6600). The provider decides whose token the runner
// receives for the repo, so the match is an EXACT hostname comparison against the configured hosts,
// and anything that does not match is refused rather than defaulted to GitHub.

import { describe, expect, it } from "vitest";
import { resolveGitProvider } from "@/lib/git/provider-host";

const PUBLIC = { gitlabBaseUrl: "https://gitlab.com" };
const SELF_HOSTED = { gitlabBaseUrl: "https://code.acme.example:8443" };

describe("resolveGitProvider", () => {
	it.each([
		["https://github.com/acme/shop", "github", "github.com"],
		["https://github.com/acme/shop.git", "github", "github.com"],
		["git@github.com:acme/shop.git", "github", "github.com"],
		["ssh://git@github.com/acme/shop.git", "github", "github.com"],
		["https://bitbucket.org/team/svc", "bitbucket", "bitbucket.org"],
		["git@bitbucket.org:team/svc.git", "bitbucket", "bitbucket.org"],
		["https://gitlab.com/group/project", "gitlab", "gitlab.com"],
		["git@gitlab.com:group/project.git", "gitlab", "gitlab.com"],
	] as const)("resolves %s to %s", (url, provider, host) => {
		expect(resolveGitProvider(url, PUBLIC)).toEqual({ ok: true, provider, host });
	});

	it("resolves a custom-domain GitLab from the configured base URL, ignoring the port", () => {
		expect(resolveGitProvider("https://code.acme.example/platform/api", SELF_HOSTED)).toEqual({
			ok: true,
			provider: "gitlab",
			host: "code.acme.example",
		});
		expect(resolveGitProvider("git@code.acme.example:platform/api.git", SELF_HOSTED)).toMatchObject({
			ok: true,
			provider: "gitlab",
		});
	});

	it("does not treat gitlab.com as GitLab once a self-hosted GitLab is configured", () => {
		expect(resolveGitProvider("https://gitlab.com/group/project", SELF_HOSTED)).toEqual({
			ok: false,
			reason: "unknown_host",
			host: "gitlab.com",
		});
	});

	it("matches hosts case-insensitively", () => {
		expect(resolveGitProvider("https://GitHub.COM/acme/shop", PUBLIC)).toMatchObject({
			ok: true,
			provider: "github",
		});
		expect(resolveGitProvider("git@BitBucket.Org:team/svc.git", PUBLIC)).toMatchObject({
			ok: true,
			provider: "bitbucket",
		});
		expect(
			resolveGitProvider("https://CODE.acme.example/a/b", { gitlabBaseUrl: "https://Code.Acme.Example" }),
		).toMatchObject({ ok: true, provider: "gitlab" });
	});

	it("refuses an unknown host instead of defaulting to GitHub", () => {
		expect(resolveGitProvider("https://git.example.net/acme/shop", PUBLIC)).toEqual({
			ok: false,
			reason: "unknown_host",
			host: "git.example.net",
		});
	});

	it.each([
		"https://evilgithub.com/acme/shop",
		"https://github.com.evil.io/acme/shop",
		"https://api.github.com/acme/shop",
		"https://www.github.com/acme/shop",
		"https://evilbitbucket.org/team/svc",
		"https://bitbucket.org.evil.io/team/svc",
		"https://my-gitlab.evil.io/group/project",
		"https://gitlab.com.evil.io/group/project",
		"https://evil.io/github.com/acme/shop",
		"https://github.com@evil.io/acme/shop",
		"git@evil.io:github.com/acme/shop",
	])("refuses the look-alike %s", (url) => {
		expect(resolveGitProvider(url, PUBLIC)).toMatchObject({ ok: false, reason: "unknown_host" });
	});

	it("refuses a subdomain of a self-hosted GitLab", () => {
		expect(resolveGitProvider("https://evil.code.acme.example/a/b", SELF_HOSTED)).toMatchObject({
			ok: false,
			reason: "unknown_host",
		});
	});

	it.each([
		["", "empty"],
		["   ", "empty"],
		["not a url", "malformed"],
		["acme/shop", "malformed"],
		["https://", "malformed"],
		["http://github.com/acme/shop", "unsupported_scheme"],
		["oci://ghcr.io/acme/chart", "unsupported_scheme"],
		["file:///etc/passwd", "unsupported_scheme"],
		["https://github.com\\@evil.io/acme/shop", "malformed"],
		["https://github.com\\evil/acme/shop", "malformed"],
		["https://\uff47ithub.com/acme/shop", "malformed"],
		["https://github.com/acme/my shop", "malformed"],
	] as const)("refuses %j as %s", (url, reason) => {
		expect(resolveGitProvider(url, PUBLIC)).toEqual({ ok: false, reason, host: null });
	});

	it("matches no GitLab host when the configured base URL is malformed", () => {
		expect(resolveGitProvider("https://gitlab.com/group/project", { gitlabBaseUrl: "::" })).toMatchObject(
			{ ok: false, reason: "unknown_host" },
		);
	});
});
