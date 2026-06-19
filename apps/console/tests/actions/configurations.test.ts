// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

function cleanEmptyUuids(
	data: Record<string, unknown>,
): Record<string, unknown> {
	const uuidFields = [
		"zone_id",
		"cluster_id",
		"cloud_identity_id",
	];
	const cleaned = { ...data };
	for (const field of uuidFields) {
		if (cleaned[field] === "" || cleaned[field] === undefined) {
			cleaned[field] = null;
		}
	}
	return cleaned;
}

function shouldAutoProvision(data: {
	cloud_identity_id?: string | null;
	zone_id?: string | null;
}): boolean {
	return !!(data.cloud_identity_id && data.zone_id);
}

describe("Configuration UUID cleanup", () => {
	it("converts empty string UUIDs to null", () => {
		const result = cleanEmptyUuids({
			zone_id: "",
			cluster_id: "",
			cloud_identity_id: "",
			project_name: "test",
		});
		expect(result.zone_id).toBeNull();
		expect(result.cluster_id).toBeNull();
		expect(result.cloud_identity_id).toBeNull();
		expect(result.project_name).toBe("test");
	});

	it("preserves valid UUIDs", () => {
		const uuid = "550e8400-e29b-41d4-a716-446655440000";
		const result = cleanEmptyUuids({ zone_id: uuid });
		expect(result.zone_id).toBe(uuid);
	});

	it("converts undefined to null", () => {
		const result = cleanEmptyUuids({});
		expect(result.zone_id).toBeNull();
	});
});

describe("Auto-provision logic", () => {
	it("should auto-provision when both identity and zone set", () => {
		expect(
			shouldAutoProvision({
				cloud_identity_id: "id",
				zone_id: "vid",
			}),
		).toBe(true);
	});

	it("should not auto-provision when identity missing", () => {
		expect(
			shouldAutoProvision({
				cloud_identity_id: null,
				zone_id: "vid",
			}),
		).toBe(false);
	});

	it("should not auto-provision when zone missing", () => {
		expect(
			shouldAutoProvision({
				cloud_identity_id: "id",
				zone_id: null,
			}),
		).toBe(false);
	});

	it("should not auto-provision when both missing", () => {
		expect(shouldAutoProvision({})).toBe(false);
	});
});
