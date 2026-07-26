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
