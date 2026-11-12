// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6543: from ingress-nginx's removal date, enableAddon refuses a NEW install — the one answer the
// console and the CLI both get — and still accepts a reconfigure of an environment that has it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/app/server/actions/resolve", () => ({
	resolveActiveEnvironmentId: vi.fn(),
}));

import { enableAddon } from "@/app/server/actions/addons";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { getAddOn } from "@/lib/addons/catalog";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";

/** A drizzle-shaped tx stub whose existing-row select returns `existing`; records whether it wrote. */
function setupDb(existing: Array<{ values: Record<string, unknown> }>) {
	const wrote = { insert: false };
	const select = {
		from: () => select,
		where: () => select,
		limit: () => Promise.resolve(existing),
	};
	const insert = {
		values: () => {
			wrote.insert = true;
			return insert;
		},
		onConflictDoUpdate: () => Promise.resolve(undefined),
	};
	const tx = { select: () => select, insert: () => insert };
	vi.mocked(withActorScope).mockImplementation(
		// The stub cannot satisfy drizzle's PgTransaction type; same shape addons-version.test.ts uses.
		((_actor: unknown, cb: (t: unknown) => unknown) => cb(tx)) as never,
	);
	return wrote;
}

const BASE = { projectId: "proj-1", environmentId: "env-1", addonId: "ingress-nginx" };
const REMOVAL = getAddOn("ingress-nginx")?.deprecated?.removalDate ?? "unset";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({
		userId: "u-1",
		orgId: "o-1",
	} as Awaited<ReturnType<typeof authorize>>);
	vi.mocked(resolveActiveEnvironmentId).mockResolvedValue("env-1");
});

afterEach(() => {
	vi.useRealTimers();
});

describe("enableAddon — a deprecated add-on", () => {
	it("refuses a new install from the removal date, naming the replacement", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(`${REMOVAL}T00:00:00Z`));
		const wrote = setupDb([]);
		await expect(enableAddon(BASE)).rejects.toThrow(
			/Ingress NGINX is deprecated and no longer accepts new installs.*Enable Traefik \(traefik\) instead/,
		);
		expect(wrote.insert).toBe(false);
	});

	it("accepts a reconfigure of an environment that already has it, after the date", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
		const wrote = setupDb([{ values: {} }]);
		await expect(enableAddon({ ...BASE, version: "4.15.1" })).resolves.toEqual({ ok: true });
		expect(wrote.insert).toBe(true);
	});

	it("accepts a new install before the removal date", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
		const wrote = setupDb([]);
		await expect(enableAddon(BASE)).resolves.toEqual({ ok: true });
		expect(wrote.insert).toBe(true);
	});
});
