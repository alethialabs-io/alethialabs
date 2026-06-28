// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runner release lookups (lib/runners/version.ts). Mocked boundary: a thenable drizzle chain feeds
// rows; assert the released_at Date→ISO shaping and the row-present/absent → release|null branch.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { getLatestRunnerRelease, getRunnerRelease } from "@/lib/runners/version";
import { getServiceDb } from "@/lib/db";

function mockDb(rows: unknown[]) {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		orderBy: () => db,
		limit: () => db,
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
}

const row = {
	version: "1.2.3",
	release_notes: "notes",
	released_at: new Date("2026-01-02T03:04:05.000Z"),
	github_release_url: null,
	commit_sha: null,
	is_breaking: false,
};

beforeEach(() => vi.clearAllMocks());

describe("getLatestRunnerRelease", () => {
	it("shapes the row and converts released_at to an ISO string", async () => {
		mockDb([row]);
		const r = await getLatestRunnerRelease();
		expect(r?.version).toBe("1.2.3");
		expect(r?.released_at).toBe("2026-01-02T03:04:05.000Z"); // Date → ISO
		expect(r?.is_breaking).toBe(false);
	});

	it("returns null when there are no releases", async () => {
		mockDb([]);
		expect(await getLatestRunnerRelease()).toBeNull();
	});
});

describe("getRunnerRelease", () => {
	it("returns the shaped release for a version", async () => {
		mockDb([{ ...row, version: "9.9.9", is_breaking: true }]);
		const r = await getRunnerRelease("9.9.9");
		expect(r?.version).toBe("9.9.9");
		expect(r?.is_breaking).toBe(true);
		expect(r?.released_at).toBe("2026-01-02T03:04:05.000Z");
	});

	it("returns null for an unknown version", async () => {
		mockDb([]);
		expect(await getRunnerRelease("0.0.0")).toBeNull();
	});
});
