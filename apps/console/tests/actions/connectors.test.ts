// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

function mergeConnectorsWithConnections(
	connectors: Array<{
		slug: string;
		category: string;
		name: string;
	}>,
	gitTokens: Set<string>,
	cloudIdentities: Array<{
		provider: string;
		credentials: { account_id?: string; role_arn?: string };
	}>,
	identityMap: Map<
		string,
		{ username?: string; avatar_url?: string; id?: string }
	>,
) {
	return connectors.map((connector) => {
		let connected = false;
		let connection_details: Record<string, unknown> | null = null;

		if (connector.category === "git") {
			connected = gitTokens.has(connector.slug);
			const identity = identityMap.get(connector.slug);
			if (connected && identity) {
				connection_details = {
					username: identity.username,
					avatar_url: identity.avatar_url,
					identity_id: identity.id,
				};
			}
		} else if (connector.category === "cloud") {
			const cloudIdentity = cloudIdentities.find(
				(ci) => ci.provider === connector.slug,
			);
			if (cloudIdentity) {
				connected = true;
				connection_details = {
					account_id: cloudIdentity.credentials?.account_id,
					role_arn: cloudIdentity.credentials?.role_arn,
				};
			}
		}

		return { ...connector, connected, connection_details };
	});
}

describe("Connector status merging", () => {
	const connectors = [
		{ slug: "github", category: "git", name: "GitHub" },
		{ slug: "gitlab", category: "git", name: "GitLab" },
		{ slug: "aws", category: "cloud", name: "AWS" },
		{ slug: "gcp", category: "cloud", name: "GCP" },
	];

	it("marks git providers as connected when token exists", () => {
		const result = mergeConnectorsWithConnections(
			connectors,
			new Set(["github"]),
			[],
			new Map([
				[
					"github",
					{ username: "user1", avatar_url: "https://example.com/avatar", id: "id1" },
				],
			]),
		);

		expect(result[0].connected).toBe(true);
		expect(result[0].connection_details?.username).toBe("user1");
		expect(result[1].connected).toBe(false);
	});

	it("marks cloud providers as connected when identity exists", () => {
		const result = mergeConnectorsWithConnections(
			connectors,
			new Set(),
			[
				{
					provider: "aws",
					credentials: {
						account_id: "123456789012",
						role_arn: "arn:aws:iam::123456789012:role/Test",
					},
				},
			],
			new Map(),
		);

		expect(result[2].connected).toBe(true);
		expect(result[2].connection_details?.account_id).toBe("123456789012");
		expect(result[3].connected).toBe(false);
	});

	it("handles no connections", () => {
		const result = mergeConnectorsWithConnections(
			connectors,
			new Set(),
			[],
			new Map(),
		);

		expect(result.every((i) => !i.connected)).toBe(true);
		expect(result.every((i) => i.connection_details === null)).toBe(true);
	});

	it("handles all connected", () => {
		const result = mergeConnectorsWithConnections(
			connectors,
			new Set(["github", "gitlab"]),
			[
				{ provider: "aws", credentials: { account_id: "123" } },
				{ provider: "gcp", credentials: {} },
			],
			new Map([
				["github", { username: "u1" }],
				["gitlab", { username: "u2" }],
			]),
		);

		expect(result.every((i) => i.connected)).toBe(true);
	});
});
