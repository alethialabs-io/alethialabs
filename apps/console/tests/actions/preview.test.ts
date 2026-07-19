// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the ephemeral PR-preview-environments (W-f, #842) resolver: stub the
// authz guard, the env resolver, and a table-aware thenable drizzle chain (withActorScope). Covers
// the flag gate, the fail-closed reasons (no Fabric / no apps repo / unsupported SCM host), the
// happy path (derived SCM coords + placement), and the user placement/TTL override. The pure
// parseAppsRepoScm helper is unit-tested directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn() }));
vi.mock("@/app/server/actions/resolve", () => ({ resolveActiveEnvironmentId: vi.fn() }));

import { getPreviewConfig } from "@/app/server/actions/preview";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { projectEnvironments, projectFabrics, projectRepositories } from "@/lib/db/schema";
import { parseAppsRepoScm } from "@/lib/validations/preview";

type Rows = unknown[];

/** Table-aware thenable drizzle-ish tx wired through withActorScope. Each table answers with its
 * configured rows; a missing table answers []. */
function setupDb(select: Map<unknown, Rows>) {
	function makeChain(table?: unknown) {
		let from = table;
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			from: (t: unknown) => {
				from = t;
				return c;
			},
			where: () => c,
			limit: () => c,
			then: (res: (v: Rows) => void) => res(select.get(from) ?? []),
		});
		return c;
	}
	const db = { select: () => makeChain() };
	vi.mocked(withActorScope).mockImplementation(
		((_actor: unknown, cb: (tx: unknown) => unknown) => cb(db)) as never,
	);
}

const OLD_FLAG = process.env.ALETHIA_PREVIEW_ENVS_ENABLED;

beforeEach(() => {
	vi.clearAllMocks();
	process.env.ALETHIA_PREVIEW_ENVS_ENABLED = "true";
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	vi.mocked(resolveActiveEnvironmentId).mockResolvedValue("env-1" as never);
});

afterEach(() => {
	if (OLD_FLAG === undefined) delete process.env.ALETHIA_PREVIEW_ENVS_ENABLED;
	else process.env.ALETHIA_PREVIEW_ENVS_ENABLED = OLD_FLAG;
});

/** A fully-wired happy-path DB: env→Fabric, an apps repo, and the Fabric row. */
function happyDb(placementMode = "namespace") {
	setupDb(
		new Map<unknown, Rows>([
			[projectEnvironments, [{ fabric_id: "fab-1", placement_mode: placementMode, name: "production" }]],
			[projectRepositories, [{ apps_destination_repo: "https://github.com/acme/manifests" }]],
			[projectFabrics, [{ name: "prod-fabric" }]],
		]),
	);
}

describe("getPreviewConfig", () => {
	it("is unavailable when the feature flag is off", async () => {
		process.env.ALETHIA_PREVIEW_ENVS_ENABLED = "false";
		const res = await getPreviewConfig("p1", "env-1");
		expect(res).toEqual({ available: false, reason: expect.stringMatching(/not enabled/i) });
		// Short-circuits before authz/DB.
		expect(authorize).not.toHaveBeenCalled();
	});

	it("is unavailable when the environment has no Fabric", async () => {
		setupDb(
			new Map<unknown, Rows>([
				[projectEnvironments, [{ fabric_id: null, placement_mode: "dedicated", name: "production" }]],
			]),
		);
		const res = await getPreviewConfig("p1", "env-1");
		expect(res).toEqual({ available: false, reason: expect.stringMatching(/not linked to a Fabric/i) });
	});

	it("is unavailable without a GitOps apps repository", async () => {
		setupDb(
			new Map<unknown, Rows>([
				[projectEnvironments, [{ fabric_id: "fab-1", placement_mode: "namespace", name: "production" }]],
				[projectRepositories, [{ apps_destination_repo: null }]],
			]),
		);
		const res = await getPreviewConfig("p1", "env-1");
		expect(res).toEqual({ available: false, reason: expect.stringMatching(/apps repository/i) });
	});

	it("is unavailable when the apps repo host is not a supported SCM", async () => {
		setupDb(
			new Map<unknown, Rows>([
				[projectEnvironments, [{ fabric_id: "fab-1", placement_mode: "namespace", name: "production" }]],
				[projectRepositories, [{ apps_destination_repo: "https://bitbucket.org/acme/manifests" }]],
			]),
		);
		const res = await getPreviewConfig("p1", "env-1");
		expect(res).toEqual({ available: false, reason: expect.stringMatching(/not supported/i) });
	});

	it("resolves the derived config for a github apps repo", async () => {
		happyDb("namespace");
		const res = await getPreviewConfig("p1", "env-1");
		expect(res.available).toBe(true);
		if (!res.available) throw new Error("expected available");
		expect(res.config).toMatchObject({
			fabricId: "fab-1",
			fabricName: "prod-fabric",
			appsRepo: "https://github.com/acme/manifests",
			scmProvider: "github",
			scmOwner: "acme",
			scmRepo: "manifests",
			placement: "namespace",
			namespacePrefix: "preview",
			ttlHours: 72,
			tokenSecretName: "preview-scm-token",
			tokenSecretKey: "token",
		});
	});

	it("falls back to namespace placement for a dedicated host env", async () => {
		happyDb("dedicated");
		const res = await getPreviewConfig("p1", "env-1");
		if (!res.available) throw new Error("expected available");
		expect(res.config.placement).toBe("namespace");
	});

	it("overlays a validated user placement + TTL choice", async () => {
		happyDb("namespace");
		const res = await getPreviewConfig("p1", "env-1", { placement: "vcluster", ttlHours: 24 });
		if (!res.available) throw new Error("expected available");
		expect(res.config.placement).toBe("vcluster");
		expect(res.config.ttlHours).toBe(24);
	});

	it("rejects an invalid TTL override", async () => {
		happyDb("namespace");
		await expect(
			getPreviewConfig("p1", "env-1", { placement: "namespace", ttlHours: -5 }),
		).rejects.toThrow();
	});
});

describe("parseAppsRepoScm", () => {
	it("parses https github", () => {
		expect(parseAppsRepoScm("https://github.com/acme/manifests")).toEqual({
			provider: "github",
			owner: "acme",
			repo: "manifests",
		});
	});

	it("parses a .git suffix and ssh form", () => {
		expect(parseAppsRepoScm("git@github.com:acme/manifests.git")).toEqual({
			provider: "github",
			owner: "acme",
			repo: "manifests",
		});
	});

	it("keeps nested gitlab group paths as the owner", () => {
		expect(parseAppsRepoScm("https://gitlab.com/acme/team/manifests")).toEqual({
			provider: "gitlab",
			owner: "acme/team",
			repo: "manifests",
		});
	});

	it("returns null for an unsupported host or malformed url", () => {
		expect(parseAppsRepoScm("https://bitbucket.org/acme/manifests")).toBeNull();
		expect(parseAppsRepoScm("https://github.com/onlyone")).toBeNull();
		expect(parseAppsRepoScm("not-a-url")).toBeNull();
		expect(parseAppsRepoScm("")).toBeNull();
	});

	it("rejects owner/repo with YAML-unsafe characters (injection guard)", () => {
		// A colon / quote / newline in a path segment would land unquoted in the rendered manifest.
		expect(parseAppsRepoScm("https://github.com/a:b/manifests")).toBeNull();
		expect(parseAppsRepoScm('https://github.com/acme/man"ifests')).toBeNull();
		expect(parseAppsRepoScm("https://github.com/acme/mani{fests")).toBeNull();
	});
});
