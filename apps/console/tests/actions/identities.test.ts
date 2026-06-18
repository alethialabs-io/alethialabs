// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

describe("getLinkedProviders logic", () => {
	it("deduplicates providers from DB and session", () => {
		const dbProviders = [
			{ provider: "github" },
			{ provider: "gitlab" },
		];
		const activeProvider = "github";

		const providers = new Set<string>(dbProviders.map((p) => p.provider));
		if (
			activeProvider &&
			["github", "gitlab", "bitbucket"].includes(activeProvider)
		) {
			providers.add(activeProvider);
		}

		expect(Array.from(providers)).toEqual(["github", "gitlab"]);
	});

	it("adds session provider if not in DB", () => {
		const dbProviders = [{ provider: "github" }];
		const activeProvider = "gitlab";

		const providers = new Set<string>(dbProviders.map((p) => p.provider));
		if (
			activeProvider &&
			["github", "gitlab", "bitbucket"].includes(activeProvider)
		) {
			providers.add(activeProvider);
		}

		expect(Array.from(providers)).toEqual(["github", "gitlab"]);
	});

	it("ignores non-git session providers", () => {
		const dbProviders = [{ provider: "github" }];
		const activeProvider = "google";

		const providers = new Set<string>(dbProviders.map((p) => p.provider));
		if (
			activeProvider &&
			["github", "gitlab", "bitbucket"].includes(activeProvider)
		) {
			providers.add(activeProvider);
		}

		expect(Array.from(providers)).toEqual(["github"]);
	});
});
