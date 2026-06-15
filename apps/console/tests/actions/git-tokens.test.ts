// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

function buildIdentityMap(
	identities: Array<{
		provider: string;
		identity_data?: {
			user_name?: string;
			preferred_username?: string;
			name?: string;
		};
	}>,
): Map<string, string> {
	const map = new Map<string, string>();
	for (const identity of identities) {
		if (["github", "gitlab", "bitbucket"].includes(identity.provider)) {
			map.set(
				identity.provider,
				identity.identity_data?.user_name ||
					identity.identity_data?.preferred_username ||
					identity.identity_data?.name ||
					identity.provider,
			);
		}
	}
	return map;
}

describe("Identity map building", () => {
	it("maps git providers to usernames", () => {
		const map = buildIdentityMap([
			{
				provider: "github",
				identity_data: { user_name: "ghuser" },
			},
			{
				provider: "gitlab",
				identity_data: { preferred_username: "gluser" },
			},
		]);
		expect(map.get("github")).toBe("ghuser");
		expect(map.get("gitlab")).toBe("gluser");
	});

	it("falls back through username fields", () => {
		const map = buildIdentityMap([
			{
				provider: "github",
				identity_data: { name: "Full Name" },
			},
		]);
		expect(map.get("github")).toBe("Full Name");
	});

	it("uses provider name as last resort", () => {
		const map = buildIdentityMap([
			{ provider: "bitbucket", identity_data: {} },
		]);
		expect(map.get("bitbucket")).toBe("bitbucket");
	});

	it("ignores non-git providers", () => {
		const map = buildIdentityMap([
			{
				provider: "google",
				identity_data: { user_name: "googleuser" },
			},
		]);
		expect(map.size).toBe(0);
	});

	it("handles empty identities", () => {
		const map = buildIdentityMap([]);
		expect(map.size).toBe(0);
	});
});
