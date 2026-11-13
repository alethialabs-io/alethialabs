// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	parsePreviewRepositoryUrl,
	previewRepositoryPartsFromRepository,
} from "@/lib/git/preview-repository";

describe("parsePreviewRepositoryUrl", () => {
	it("parses GitHub repository URLs", () => {
		expect(parsePreviewRepositoryUrl("https://github.com/acme/shop.git")).toEqual({
			git_provider: "github",
			repo_owner: "acme",
			repo_name: "shop",
		});
	});

	it("parses Bitbucket repository URLs", () => {
		expect(parsePreviewRepositoryUrl("https://bitbucket.org/team/svc")).toEqual({
			git_provider: "bitbucket",
			repo_owner: "team",
			repo_name: "svc",
		});
	});

	it("parses the configured GitLab host", () => {
		expect(
			parsePreviewRepositoryUrl(
				"https://gitlab.example.com/acme/platform",
				"https://gitlab.example.com",
			),
		).toEqual({
			git_provider: "gitlab",
			repo_owner: "acme",
			repo_name: "platform",
		});
	});

	it("parses a custom-domain GitLab with no 'gitlab' in its name, on the base URL's port", () => {
		expect(
			parsePreviewRepositoryUrl("https://code.acme.example:8443/acme/platform", "https://code.acme.example:8443"),
		).toEqual({ git_provider: "gitlab", repo_owner: "acme", repo_name: "platform" });
		expect(
			parsePreviewRepositoryUrl("https://code.acme.example/acme/platform", "https://code.acme.example:8443"),
		).toBeNull();
	});

	it("does not treat gitlab.com as GitLab once a self-hosted GitLab is configured", () => {
		expect(parsePreviewRepositoryUrl("https://gitlab.com/acme/shop", "https://code.acme.example")).toBeNull();
	});

	it.each([
		"https://git.example.net/acme/shop",
		"https://www.github.com/acme/shop",
		"https://api.bitbucket.org/team/svc",
		"https://evil.code.acme.example/acme/shop",
		"https://github.com.evil.io/acme/shop",
		"http://github.com/acme/shop",
		"git@github.com:acme/shop.git",
	])("refuses %s instead of guessing a provider", (url) => {
		expect(parsePreviewRepositoryUrl(url, "https://code.acme.example")).toBeNull();
	});

	it("rejects unsupported hosts and nested namespaces", () => {
		expect(parsePreviewRepositoryUrl("https://example.com/acme/shop")).toBeNull();
		expect(parsePreviewRepositoryUrl("https://gitlab.com/acme/team/shop")).toBeNull();
	});
});

describe("previewRepositoryPartsFromRepository", () => {
	it("maps a selected repository row", () => {
		expect(
			previewRepositoryPartsFromRepository({
				id: "1",
				name: "shop",
				full_name: "acme/shop",
				url: "https://github.com/acme/shop",
				private: false,
				default_branch: "main",
				provider: "github",
			}),
		).toEqual({
			git_provider: "github",
			repo_owner: "acme",
			repo_name: "shop",
		});
	});
});
