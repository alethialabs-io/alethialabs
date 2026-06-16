// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

function cleanEmptyUuids(
	data: Record<string, unknown>,
): Record<string, unknown> {
	const uuidFields = [
		"vineyard_id",
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
	vineyard_id?: string | null;
}): boolean {
	return !!(data.cloud_identity_id && data.vineyard_id);
}

describe("Configuration UUID cleanup", () => {
	it("converts empty string UUIDs to null", () => {
		const result = cleanEmptyUuids({
			vineyard_id: "",
			cluster_id: "",
			cloud_identity_id: "",
			project_name: "test",
		});
		expect(result.vineyard_id).toBeNull();
		expect(result.cluster_id).toBeNull();
		expect(result.cloud_identity_id).toBeNull();
		expect(result.project_name).toBe("test");
	});

	it("preserves valid UUIDs", () => {
		const uuid = "550e8400-e29b-41d4-a716-446655440000";
		const result = cleanEmptyUuids({ vineyard_id: uuid });
		expect(result.vineyard_id).toBe(uuid);
	});

	it("converts undefined to null", () => {
		const result = cleanEmptyUuids({});
		expect(result.vineyard_id).toBeNull();
	});
});

describe("Auto-provision logic", () => {
	it("should auto-provision when both identity and vineyard set", () => {
		expect(
			shouldAutoProvision({
				cloud_identity_id: "id",
				vineyard_id: "vid",
			}),
		).toBe(true);
	});

	it("should not auto-provision when identity missing", () => {
		expect(
			shouldAutoProvision({
				cloud_identity_id: null,
				vineyard_id: "vid",
			}),
		).toBe(false);
	});

	it("should not auto-provision when vineyard missing", () => {
		expect(
			shouldAutoProvision({
				cloud_identity_id: "id",
				vineyard_id: null,
			}),
		).toBe(false);
	});

	it("should not auto-provision when both missing", () => {
		expect(shouldAutoProvision({})).toBe(false);
	});
});
