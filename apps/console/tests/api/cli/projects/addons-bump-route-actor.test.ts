// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/projects/:id/addons/bump (#6549), through the REAL `requestGitopsBump` and service:
// whose GitHub account the pull request is opened with depends on the credential that called. A
// person's own; a service token pinned to its minter's personal workspace, the minter's; a service
// token pinned to any other org, nobody's, so it is refused before any token is read.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/authz/types";

const { state } = vi.hoisted(() => {
	const state: { actor: Actor | null } = { actor: null };
	return { state };
});

vi.mock("@/lib/authz/actor-context", () => ({
	runWithActor: (_actor: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: async () => ({ actor: state.actor, credential: state.actor?.credential, orgScope: [state.actor?.orgId] }),
	// The action re-authorises inside `runWithActor`, which answers with the CLI's actor.
	authorize: async () => state.actor,
}));
vi.mock("@/lib/cli/project-access", () => ({
	resolveCliProjectAuthorized: async () => ({ id: "44444444-4444-4444-8444-444444444444" }),
}));
vi.mock("@/lib/cli/resolve-project", () => ({
	resolveCliWriteEnvironment: async () => ({ ok: true, id: "55555555-5555-4555-8555-555555555555", name: "prod" }),
}));
vi.mock("@/app/server/actions/resolve", () => ({
	resolveActiveEnvironmentId: async () => "55555555-5555-4555-8555-555555555555",
}));
vi.mock("@/lib/auth/provider-token", () => ({ providerTokenForUser: vi.fn(async () => null) }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), getServiceDb: vi.fn() }));

import { POST } from "@/app/api/cli/projects/[id]/addons/bump/route";
import { providerTokenForUser } from "@/lib/auth/provider-token";
import { withActorScope } from "@/lib/db";
import { cliGitopsBumpResponse } from "@/lib/validations/cli-contract";

/** A drizzle-shaped tx: the add-on row is a GitOps ingress-nginx, the apps repo a GitHub one. */
function stubDb() {
	const answers = [
		[{ mode: "gitops", source: "catalog", version: "4.15.1", gitopsBump: null }],
		[{ apps: "https://github.com/acme/apps" }],
	];
	let n = 0;
	const select = {
		from: () => select,
		where: () => select,
		limit: () => Promise.resolve(answers[n++ % answers.length]),
	};
	const tx = { select: () => select, update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) };
	vi.mocked(withActorScope).mockImplementation(
		// The stub cannot satisfy drizzle's PgTransaction type; same shape addons-version.test.ts uses.
		((_actor: unknown, cb: (t: unknown) => unknown) => cb(tx)) as never,
	);
}

/** POSTs a bump as the CLI would. */
async function post() {
	const res = await POST(
		new Request("https://console.local/api/cli/projects/shop/addons/bump", {
			method: "POST",
			body: JSON.stringify({ addon_id: "ingress-nginx" }),
		}),
		{ params: Promise.resolve({ id: "shop" }) },
	);
	return { status: res.status, body: cliGitopsBumpResponse.parse(await res.json()) };
}

beforeEach(() => {
	vi.mocked(providerTokenForUser).mockReset();
	vi.mocked(providerTokenForUser).mockResolvedValue(null);
	stubDb();
});

describe("POST .../addons/bump — whose GitHub account", () => {
	it("a service token pinned to a shared org is refused, and NO token is read", async () => {
		state.actor = { userId: "minter-1", orgId: "org-shared", credential: "service_token" };
		const { status, body } = await post();
		expect(status).toBe(200);
		expect(body).toMatchObject({ status: "refused", reason: "not-a-person", number: null, url: null });
		expect(body.message).toContain("person's own GitHub account");
		expect(providerTokenForUser).not.toHaveBeenCalled();
	});

	// The controls: the same request reaches the token read for a person, so the refusal above is
	// the credential's doing and not a stub that never gets that far.
	it("a person's request reads that person's own token", async () => {
		state.actor = { userId: "user-1", orgId: "org-shared", credential: "session" };
		const { body } = await post();
		expect(body).toMatchObject({ status: "refused", reason: "no-git-link" });
		expect(providerTokenForUser).toHaveBeenCalledWith("user-1", "github");
	});

	it("a service token pinned to its minter's own personal workspace reads the minter's token", async () => {
		state.actor = { userId: "user-9", orgId: "user-9", credential: "service_token" };
		await post();
		expect(providerTokenForUser).toHaveBeenCalledWith("user-9", "github");
	});
});
