// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the org-settings actions: stub the actor + a thenable drizzle chain
// (so `await db.select()…limit(1)` resolves to seeded rows) and assert the metadata-JSON parsing,
// defaults, personal-scope guards, and the address merge.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import {
	getOrgSettings,
	updateOrgPrimaryAddress,
} from "@/app/server/actions/org-settings";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";

/** A drizzle-ish chain whose every builder returns itself and which awaits to `rows`. */
function mockDb(rows: unknown[]) {
	const setSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => db,
		update: () => db,
		set: (...a: unknown[]) => {
			setSpy(...a);
			return db;
		},
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { setSpy };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentActor).mockResolvedValue({ orgId: "org-1", userId: "user-1" } as never);
});

describe("getOrgSettings", () => {
	it("returns null in the personal scope", async () => {
		vi.mocked(currentActor).mockResolvedValue({ orgId: "user-1", userId: "user-1" } as never);
		expect(await getOrgSettings()).toBeNull();
	});

	it("parses metadata JSON and surfaces its fields", async () => {
		mockDb([
			{
				name: "Acme",
				slug: "acme",
				logo: null,
				metadata: JSON.stringify({
					description: "Our team",
					region: "us-east-1",
					defaultEnv: "production",
					terraformVersion: "1.10.0",
				}),
			},
		]);
		const s = await getOrgSettings();
		expect(s).toMatchObject({
			name: "Acme",
			slug: "acme",
			description: "Our team",
			region: "us-east-1",
			defaultEnv: "production",
			terraformVersion: "1.10.0",
		});
	});

	it("falls back to defaults when metadata is missing or malformed", async () => {
		mockDb([{ name: "Acme", slug: "acme", logo: null, metadata: "{not json" }]);
		const s = await getOrgSettings();
		expect(s).toMatchObject({ region: "eu-west-1", defaultEnv: "staging", terraformVersion: "1.9.5", description: "" });
	});

	it("returns null when the org row is missing", async () => {
		mockDb([]);
		expect(await getOrgSettings()).toBeNull();
	});
});

describe("updateOrgPrimaryAddress", () => {
	it("refuses the personal scope", async () => {
		vi.mocked(currentActor).mockResolvedValue({ orgId: "user-1", userId: "user-1" } as never);
		await expect(
			updateOrgPrimaryAddress({ name: "X", line1: "1 St", country: "EE" }),
		).rejects.toThrow(/No organization/);
	});

	it("merges the address into existing metadata", async () => {
		const { setSpy } = mockDb([{ metadata: JSON.stringify({ region: "eu-west-1" }) }]);
		const r = await updateOrgPrimaryAddress({ name: "Acme", line1: "1 St", country: "EE" });
		expect(r).toEqual({ ok: true });
		const written = JSON.parse(setSpy.mock.calls[0][0].metadata);
		expect(written.region).toBe("eu-west-1"); // preserved
		expect(written.primaryAddress).toMatchObject({ name: "Acme", country: "EE" }); // merged
	});
});
