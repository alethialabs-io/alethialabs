// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins how a repo URL is tied to a git provider (#6600). The provider decides whose token the runner
// receives for the repo, so the match is an EXACT hostname comparison against the configured hosts,
// and anything that does not match is refused rather than defaulted to GitHub. The port a token
// would go to is part of the match.

import { describe, expect, it } from "vitest";
import { portMismatchMessage, repoHostForLog, resolveGitProvider } from "@/lib/git/provider-host";

const PUBLIC = { gitlabBaseUrl: "https://gitlab.com" };
const SELF_HOSTED = { gitlabBaseUrl: "https://code.acme.example:8443" };
const CUSTOM_DOMAIN = { gitlabBaseUrl: "https://code.acme.example" };

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

	it("resolves a custom-domain GitLab from the configured base URL, on the base URL's port", () => {
		expect(resolveGitProvider("https://code.acme.example:8443/platform/api", SELF_HOSTED)).toEqual({
			ok: true,
			provider: "gitlab",
			host: "code.acme.example",
		});
		expect(resolveGitProvider("https://code.acme.example/platform/api", CUSTOM_DOMAIN)).toEqual({
			ok: true,
			provider: "gitlab",
			host: "code.acme.example",
		});
		expect(resolveGitProvider("git@code.acme.example:platform/api.git", CUSTOM_DOMAIN)).toMatchObject({
			ok: true,
			provider: "gitlab",
		});
		expect(resolveGitProvider("ssh://git@code.acme.example:2222/platform/api.git", CUSTOM_DOMAIN)).toMatchObject({
			ok: true,
			provider: "gitlab",
		});
		// An explicit :443 is the default port, written out.
		expect(resolveGitProvider("https://code.acme.example:443/platform/api", CUSTOM_DOMAIN)).toMatchObject({
			ok: true,
			provider: "gitlab",
		});
	});

	it.each([
		// The base URL names :8443, so a remote whose token would go to :443 is another service.
		["https://code.acme.example/platform/api", SELF_HOSTED],
		["https://code.acme.example:9443/platform/api", SELF_HOSTED],
		// An ssh or scp remote is cloned with a token over https on the default port.
		["git@code.acme.example:platform/api.git", SELF_HOSTED],
		["ssh://git@code.acme.example:8443/platform/api.git", SELF_HOSTED],
		// No port in the base URL means the default https port.
		["https://code.acme.example:8443/platform/api", CUSTOM_DOMAIN],
		["https://github.com:8443/acme/shop", PUBLIC],
		["https://bitbucket.org:444/team/svc", PUBLIC],
	] as const)("refuses %s on a port the provider is not configured at", (url, hosts) => {
		expect(resolveGitProvider(url, hosts)).toMatchObject({ ok: false, reason: "port_mismatch" });
	});

	it("carries the provider, the URL's port and the configured port on a port mismatch", () => {
		expect(resolveGitProvider("https://code.acme.example:9443/platform/api", SELF_HOSTED)).toEqual({
			ok: false,
			reason: "port_mismatch",
			host: "code.acme.example",
			provider: "gitlab",
			port: "9443",
			expectedPort: "8443",
		});
		expect(resolveGitProvider("https://github.com:8443/acme/shop", PUBLIC)).toEqual({
			ok: false,
			reason: "port_mismatch",
			host: "github.com",
			provider: "github",
			port: "8443",
			expectedPort: "443",
		});
	});

	it("compares an http: GitLab base URL with no port as port 443, not 80", () => {
		const HTTP_BASE = { gitlabBaseUrl: "http://code.acme.example" };
		expect(resolveGitProvider("https://code.acme.example/platform/api", HTTP_BASE)).toMatchObject({
			ok: true,
			provider: "gitlab",
		});
		expect(resolveGitProvider("https://code.acme.example:80/platform/api", HTTP_BASE)).toMatchObject({
			ok: false,
			reason: "port_mismatch",
			port: "80",
			expectedPort: "443",
		});
	});

	it.each([
		// The runner rewrites only a literal `git@` scp remote to https; for any other user a numeric
		// first path segment would be read as a port, so the console refuses rather than assume 443.
		["deploy@code.acme.example:8080/platform/api", CUSTOM_DOMAIN],
		["deploy@code.acme.example:platform/api.git", CUSTOM_DOMAIN],
		["deploy@github.com:2222/o/r", PUBLIC],
		["git-user@github.com:o/r", PUBLIC],
	] as const)("refuses the scp remote %s, whose user is not git", (url, hosts) => {
		expect(resolveGitProvider(url, hosts)).toEqual({ ok: false, reason: "malformed", host: null });
	});

	it("still resolves a git@ scp remote", () => {
		expect(resolveGitProvider("git@github.com:o/r", PUBLIC)).toEqual({ ok: true, provider: "github", host: "github.com" });
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
		expect(resolveGitProvider("git@git.example.net:acme/shop.git", CUSTOM_DOMAIN)).toEqual({
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
		["https:/github.com/acme/shop", "malformed"],
		["https:github.com/acme/shop", "malformed"],
		["https:///github.com/acme/shop", "malformed"],
		["HTTPS:/github.com/acme/shop", "malformed"],
		// Not an scp remote: its path starts with `//`, which git reads as a URL. Without the scp
		// pattern's lookahead this would resolve to github.com.
		["git@github.com://evil.io/acme/shop", "malformed"],
		// A second `user@` segment is not part of an scp remote's host, and a host must be hostname-shaped.
		["git@tok@evil.io:acme/shop", "malformed"],
		["ssh://git@gh%2fx/acme/shop", "malformed"],
	] as const)("refuses %j as %s", (url, reason) => {
		expect(resolveGitProvider(url, PUBLIC)).toEqual({ ok: false, reason, host: null });
	});

	it("matches no GitLab host when the configured base URL is malformed", () => {
		expect(resolveGitProvider("https://gitlab.com/group/project", { gitlabBaseUrl: "::" })).toMatchObject(
			{ ok: false, reason: "unknown_host" },
		);
	});
});

describe("portMismatchMessage", () => {
	it("names both ports for the configured GitLab and the HTTPS URL to use", () => {
		const r = resolveGitProvider("git@code.acme.example:platform/api.git", SELF_HOSTED);
		if (r.ok || r.reason !== "port_mismatch") throw new Error("expected a port mismatch");
		expect(portMismatchMessage(r, "no git token was issued")).toBe(
			"The repository URL points at code.acme.example on port 443, but the configured GitLab is at " +
				"code.acme.example:8443, so no git token was issued. Use the HTTPS URL on that port " +
				"(https://code.acme.example:8443/<group>/<repo>); SSH remotes are cloned over HTTPS on port 443.",
		);
	});

	it("says github.com is only served on 443", () => {
		const r = resolveGitProvider("https://github.com:8443/acme/shop", PUBLIC);
		if (r.ok || r.reason !== "port_mismatch") throw new Error("expected a port mismatch");
		expect(portMismatchMessage(r, "no git token was issued")).toBe(
			"The repository URL points at github.com on port 8443, but github.com is only served on port 443, " +
				"so no git token was issued. Use https://github.com/<owner>/<repo>.",
		);
	});
});

describe("repoHostForLog", () => {
	it("prints the host and never the userinfo or path", () => {
		expect(repoHostForLog("https://user:secret@github.com/acme/shop")).toBe("github.com");
		expect(repoHostForLog("git@Code.Acme.Example:a/b.git")).toBe("code.acme.example");
		expect(repoHostForLog("https:/github.com/x")).toBe("(unparsed repo URL)");
		expect(repoHostForLog("git@tok@evil.io:a/b")).toBe("(unparsed repo URL)");
	});
});
