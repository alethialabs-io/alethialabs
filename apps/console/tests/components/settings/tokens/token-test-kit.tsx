// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared fixtures for the service tokens page's component tests: list rows, the picker's environment
// read, and a `useKeysetList` result builder. No mocks are declared here — `vi.mock` is hoisted per
// test file, so each file declares its own and imports these values.

import { vi } from "vitest";
import type { TokenProjectChoices } from "@/lib/agents/service-tokens";
import type { ServiceTokenListItem } from "@/lib/queries/service-tokens";

/** The org's projects and their environments, as `agents.tokenEnvironments` answers. */
export const ENVIRONMENTS: TokenProjectChoices[] = [
	{
		projectId: "aaaaaaaa-0000-4000-8000-0000000000a1",
		projectName: "payments-api",
		environments: [
			{ id: "bbbbbbbb-0000-4000-8000-0000000000b1", name: "staging", stage: "staging" },
			{ id: "bbbbbbbb-0000-4000-8000-0000000000b2", name: "production", stage: "production" },
		],
	},
	{
		projectId: "aaaaaaaa-0000-4000-8000-0000000000a2",
		projectName: "web",
		environments: [
			{ id: "bbbbbbbb-0000-4000-8000-0000000000b3", name: "dev", stage: "development" },
			{ id: "bbbbbbbb-0000-4000-8000-0000000000b4", name: "staging", stage: "staging" },
			{ id: "bbbbbbbb-0000-4000-8000-0000000000b5", name: "production", stage: "production" },
		],
	},
];

/** An active token limited to `web`, deploying to web/staging without a person. */
export const CI_DEPLOY: ServiceTokenListItem = {
	id: "cccccccc-0000-4000-8000-0000000000c1",
	name: "ci-deploy",
	tokenPrefix: "alethia_sat_3f9aK2xQ", // gitleaks:allow — a fake token prefix for the fixture, not a credential
	scopes: ["read", "plan", "apply"],
	projectIds: ["aaaaaaaa-0000-4000-8000-0000000000a2"],
	autoApproveEnvironmentIds: ["bbbbbbbb-0000-4000-8000-0000000000b4"],
	createdAt: "2026-11-01T10:00:00.000Z",
	createdBy: { id: "user-1", name: "Dana Petrova" },
	expiresAt: null,
	lastUsedAt: null,
	revokedAt: null,
	status: "active",
	projects: [{ id: "aaaaaaaa-0000-4000-8000-0000000000a2", name: "web" }],
	autoApproveEnvironments: [
		{
			id: "bbbbbbbb-0000-4000-8000-0000000000b4",
			name: "staging",
			projectId: "aaaaaaaa-0000-4000-8000-0000000000a2",
			projectName: "web",
			stage: "staging",
		},
	],
};

/** A revoked token on every project, with nothing auto-approved. */
export const OLD_JENKINS: ServiceTokenListItem = {
	...CI_DEPLOY,
	id: "cccccccc-0000-4000-8000-0000000000c2",
	name: "old-jenkins",
	tokenPrefix: "alethia_sat_q0Lw77Yh", // gitleaks:allow — a fake token prefix for the fixture, not a credential
	scopes: ["read", "design", "plan", "apply", "destroy"],
	projectIds: null,
	projects: null,
	autoApproveEnvironmentIds: [],
	autoApproveEnvironments: [],
	revokedAt: "2026-08-01T10:00:00.000Z",
	status: "revoked",
};

/**
 * A `useKeysetList` result. `first` is the first page's query state (`list.query`); the rest are the
 * list's own fields. Defaults: settled, nothing loaded, no further page.
 */
export function keysetList(state: Record<string, unknown> = {}, first: Record<string, unknown> = {}) {
	return {
		rows: [],
		facets: null,
		universeEmpty: null,
		isPending: false,
		isPlaceholderData: false,
		hasMore: false,
		loadingMore: false,
		loadMoreFailed: false,
		loadMore: vi.fn(),
		...state,
		query: { isLoading: false, isError: false, data: undefined, error: null, refetch: vi.fn(), ...first },
	};
}

/** A landed first page holding `rows`; `universeEmpty` says whether the org holds any token at all. */
export function answered(rows: ServiceTokenListItem[], extra: Record<string, unknown> = {}) {
	return keysetList(
		{
			rows,
			facets: {
				status: [
					{ value: "active", label: null, count: 1 },
					{ value: "expired", label: null, count: 0 },
					{ value: "revoked", label: null, count: 1 },
				],
			},
			universeEmpty: rows.length === 0,
			...extra,
		},
		{ data: { pages: [{ rows }] } },
	);
}
