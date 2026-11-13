// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6599: choosing GitOps delivery for an add-on is refused when the environment's apps repo is on
// GitLab or Bitbucket, whose linked tokens cannot push. enableAddon is the one function the console
// card and the CLI both call, so this is the refusal both get.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/app/server/actions/resolve", () => ({
	resolveActiveEnvironmentId: vi.fn(),
}));
vi.mock("@/lib/config/auth", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/config/auth")>()),
	getGitlabBaseUrl: () => "https://code.acme.example",
}));

import { enableAddon } from "@/app/server/actions/addons";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { projectRepositories } from "@/lib/db/schema";

/**
 * A drizzle-shaped tx stub: a select from project_repositories answers `appsRepo`, any other select
 * answers no rows. Records whether the add-on row was written.
 */
function setupDb(appsRepo: string | null) {
	const wrote = { insert: false };
	const tx = {
		select: () => {
			let table: unknown = null;
			const chain = {
				from: (t: unknown) => {
					table = t;
					return chain;
				},
				where: () => chain,
				limit: () =>
					Promise.resolve(
						table === projectRepositories && appsRepo !== null ? [{ appsRepo }] : [],
					),
			};
			return chain;
		},
		insert: () => {
			const insert = {
				values: () => {
					wrote.insert = true;
					return insert;
				},
				onConflictDoUpdate: () => Promise.resolve(undefined),
			};
			return insert;
		},
	};
	vi.mocked(withActorScope).mockImplementation(
		// The stub cannot satisfy drizzle's PgTransaction type; same shape addons-deprecation.test.ts uses.
		((_actor: unknown, cb: (t: unknown) => unknown) => cb(tx)) as never,
	);
	return wrote;
}

const BASE = { projectId: "proj-1", environmentId: "env-1", addonId: "loki" };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({
		userId: "u-1",
		orgId: "o-1",
	} as Awaited<ReturnType<typeof authorize>>);
	vi.mocked(resolveActiveEnvironmentId).mockResolvedValue("env-1");
});

describe("enableAddon — GitOps delivery and the apps repo's provider", () => {
	it.each([
		["https://code.acme.example/acme/apps", "GitLab"],
		["https://bitbucket.org/acme/apps", "Bitbucket"],
	])("refuses GitOps mode for an apps repo at %s, and writes nothing", async (repo, name) => {
		const wrote = setupDb(repo);
		await expect(enableAddon({ ...BASE, mode: "gitops" })).rejects.toMatchObject({
			kind: "conflict",
			message: expect.stringContaining(`This environment's apps repository is on ${name}`),
		});
		expect(wrote.insert).toBe(false);
	});

	it("accepts GitOps mode for an apps repo on GitHub", async () => {
		const wrote = setupDb("https://github.com/acme/apps");
		await expect(enableAddon({ ...BASE, mode: "gitops" })).resolves.toEqual({ ok: true });
		expect(wrote.insert).toBe(true);
	});

	it.each(["https://code.acme.example/acme/apps", "https://bitbucket.org/acme/apps"])(
		"still accepts Managed mode for an apps repo at %s",
		async (repo) => {
			const wrote = setupDb(repo);
			await expect(enableAddon({ ...BASE, mode: "managed" })).resolves.toEqual({ ok: true });
			await expect(enableAddon(BASE)).resolves.toEqual({ ok: true });
			expect(wrote.insert).toBe(true);
		},
	);
});
