// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The drift-posture writes the job-status route makes after a DETECT_DRIFT job — per environment
// and per Fabric. Mocked boundary: the service DB records each upsert's row, its conflict target
// and its update set, so the latest-wins keying is what is asserted.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	/** One recorded upsert. */
	interface Upsert {
		table: unknown;
		row: unknown;
		conflict: { target: unknown; set: unknown } | null;
	}
	const upserts: Upsert[] = [];
	const db = {
		/** Starts an upsert against `table`. */
		insert(table: unknown) {
			return {
				/** Records the row and returns the conflict clause builder. */
				values(row: unknown) {
					const entry: Upsert = { table, row, conflict: null };
					upserts.push(entry);
					return {
						/** Records the conflict target and update set. */
						onConflictDoUpdate(conflict: { target: unknown; set: unknown }): Promise<void> {
							entry.conflict = conflict;
							return Promise.resolve();
						},
					};
				},
			};
		},
	};
	return { db, upserts };
});

vi.mock("@/lib/db", () => ({ getServiceDb: () => fake.db }));

import { environmentDrift, fabricDrift } from "@/lib/db/schema";
import { recordDriftPosture, recordFabricDriftPosture } from "@/lib/drift/posture";
import type { DriftDetail } from "@/types/jsonb.types";

const details: DriftDetail[] = [{ address: "aws_s3_bucket.logs", type: "aws_s3_bucket", kind: "modified" }];

beforeEach(() => {
	fake.upserts.length = 0;
});

describe("recordDriftPosture", () => {
	it("upserts the environment's posture, latest-wins per (project, environment)", async () => {
		await recordDriftPosture({
			projectId: "p1",
			environmentId: "env-1",
			inSync: false,
			drifted: 1,
			details,
			scannedAt: "2026-09-30T10:00:00.000Z",
		});
		expect(fake.upserts).toHaveLength(1);
		const [u] = fake.upserts;
		expect(u.table).toBe(environmentDrift);
		expect(u.row).toMatchObject({
			project_id: "p1",
			environment_id: "env-1",
			in_sync: false,
			drifted: 1,
			details,
			scanned_at: new Date("2026-09-30T10:00:00.000Z"),
		});
		expect(u.conflict?.target).toEqual([environmentDrift.project_id, environmentDrift.environment_id]);
		expect(u.conflict?.set).toMatchObject({ in_sync: false, drifted: 1, details });
	});

	it("accepts a project-level posture with no environment", async () => {
		await recordDriftPosture({
			projectId: "p1",
			environmentId: null,
			inSync: true,
			drifted: 0,
			details: [],
			scannedAt: "2026-09-30T10:00:00.000Z",
		});
		expect(fake.upserts[0].row).toMatchObject({ environment_id: null, in_sync: true });
	});
});

describe("recordFabricDriftPosture", () => {
	it("upserts the Fabric's posture, latest-wins per (project, fabric)", async () => {
		await recordFabricDriftPosture({
			projectId: "p1",
			fabricId: "fab-1",
			inSync: false,
			drifted: 1,
			details,
			scannedAt: "2026-09-30T10:00:00.000Z",
		});
		const [u] = fake.upserts;
		expect(u.table).toBe(fabricDrift);
		expect(u.row).toMatchObject({ project_id: "p1", fabric_id: "fab-1", in_sync: false, drifted: 1 });
		expect(u.conflict?.target).toEqual([fabricDrift.project_id, fabricDrift.fabric_id]);
		expect(u.conflict?.set).toMatchObject({ in_sync: false, drifted: 1, details });
	});
});
