// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the ephemeral PR-preview config server actions (W-f, #842).
// Assert: PDP gate (authorize edit), the inserted tenancy stamp (project_id/user_id/org_id),
// zod rejection of a `dedicated` preview placement, and the enable-toggle guard.
//
// #6128: the save answers in the mutation contract (`savePreviewConfig` → `ActionResult`), and the
// three reads moved to the `settings.preview` procedure (tests/lib/rpc/settings-procedures.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn() }));

import { savePreviewConfig, setPreviewEnabled } from "@/app/server/actions/preview";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";

const captured: {
	values?: Record<string, unknown>;
	set?: Record<string, unknown>;
} = {};

// Configurable thenable drizzle-ish tx. `selectResult` feeds .limit(); `updateResult` feeds the
// update().returning(); the insert chain records .values() and echoes it back as the row.
function makeTx(opts: {
	selectResult?: unknown[];
	updateRows?: unknown[];
}) {
	const tx: Record<string, unknown> = {};
	Object.assign(tx, {
		select: () => tx,
		from: () => tx,
		where: () => tx,
		limit: async () => opts.selectResult ?? [],
		orderBy: async () => opts.selectResult ?? [],
		insert: () => tx,
		values: (v: Record<string, unknown>) => {
			captured.values = v;
			return tx;
		},
		onConflictDoUpdate: (arg: { set: Record<string, unknown> }) => {
			captured.set = arg.set;
			return tx;
		},
		update: () => tx,
		set: (v: Record<string, unknown>) => {
			captured.set = v;
			return tx;
		},
		returning: async () => [{ id: "pc-1", ...captured.values, ...captured.set }],
		then: (resolve: (v: unknown[]) => unknown) => resolve(opts.selectResult ?? []),
	});
	// setPreviewEnabled's update chain ends in .returning() but has its own row shape.
	if (opts.updateRows) {
		tx.returning = async () => opts.updateRows;
	}
	return tx;
}

const ACTOR = { userId: "user-1", orgId: "org-1" };
const PROJECT = "11111111-1111-4111-8111-111111111111";
const VALID_INPUT = {
	enabled: true,
	git_provider: "github" as const,
	repo_owner: "acme",
	repo_name: "shop",
	placement_mode: "namespace" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	captured.values = undefined;
	captured.set = undefined;
	vi.mocked(authorize).mockResolvedValue(ACTOR as never);
});

describe("savePreviewConfig", () => {
	it("PDP-gates on project:edit and stamps tenancy on insert", async () => {
		vi.mocked(withActorScope).mockImplementation(
			((_a: unknown, cb: (tx: unknown) => unknown) =>
				cb(makeTx({ selectResult: [{ org_id: "org-1" }] }))) as never,
		);
		const res = await savePreviewConfig({ projectId: PROJECT, config: VALID_INPUT });
		expect(authorize).toHaveBeenCalledWith("edit", {
			type: "project",
			id: PROJECT,
		});
		expect(captured.values).toMatchObject({
			project_id: PROJECT,
			user_id: "user-1",
			org_id: "org-1",
			git_provider: "github",
			repo_owner: "acme",
			repo_name: "shop",
			placement_mode: "namespace",
		});
		expect(res.ok && res.data.config).toBeTruthy();
	});

	it("refuses a `dedicated` preview placement as a field error, and writes nothing", async () => {
		vi.mocked(withActorScope).mockImplementation(
			((_a: unknown, cb: (tx: unknown) => unknown) =>
				cb(makeTx({ selectResult: [{ org_id: "org-1" }] }))) as never,
		);
		const res = await savePreviewConfig({
			projectId: PROJECT,
			config: {
				...VALID_INPUT,
				// @ts-expect-error — dedicated is intentionally not a valid preview placement
				placement_mode: "dedicated",
			},
		});
		expect(res).toMatchObject({
			ok: false,
			error: { kind: "validation", fields: { "config.placement_mode": expect.any(Array) } },
		});
		expect(captured.values).toBeUndefined();
		expect(authorize).not.toHaveBeenCalled();
	});

	it("answers a project that is gone as not-found — a result, not a thrown 404", async () => {
		vi.mocked(withActorScope).mockImplementation(
			((_a: unknown, cb: (tx: unknown) => unknown) =>
				cb(makeTx({ selectResult: [] }))) as never,
		);
		expect(await savePreviewConfig({ projectId: PROJECT, config: VALID_INPUT })).toEqual({
			ok: false,
			error: { kind: "not-found", message: "This project no longer exists." },
		});
		expect(captured.values).toBeUndefined();
	});
});

describe("setPreviewEnabled", () => {
	it("updates enabled when configured", async () => {
		vi.mocked(withActorScope).mockImplementation(
			((_a: unknown, cb: (tx: unknown) => unknown) =>
				cb(makeTx({ updateRows: [{ id: "pc-1", enabled: false }] }))) as never,
		);
		const res = await setPreviewEnabled(PROJECT, false);
		expect(captured.set).toMatchObject({ enabled: false });
		expect(res.config).toMatchObject({ id: "pc-1" });
	});

	it("throws when previews are not configured", async () => {
		vi.mocked(withActorScope).mockImplementation(
			((_a: unknown, cb: (tx: unknown) => unknown) =>
				cb(makeTx({ updateRows: [] }))) as never,
		);
		await expect(setPreviewEnabled(PROJECT, true)).rejects.toThrow(
			/not configured/i,
		);
	});
});
