// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Replaces the deleted tests/actions/plan-artifact.test.ts, which asserted on inline string
// literals and JS built-ins (≈0 mutation score). Drives the REAL helpers now shared by the route.

import { describe, expect, it } from "vitest";
import {
	MAX_PLAN_ARTIFACT_BYTES,
	planArtifactKey,
	planArtifactSizeError,
} from "@/lib/storage/plan-artifact";

describe("planArtifactKey", () => {
	it("builds the per-job tofu plan key", () => {
		expect(planArtifactKey("abc123-def456")).toBe("abc123-def456/tofu.plan.out");
		expect(planArtifactKey("24b2941a-b6de-4a3f")).toMatch(/^24b2941a-b6de-4a3f\/tofu\.plan\.out$/);
	});
});

describe("planArtifactSizeError", () => {
	it("flags an empty body", () => {
		expect(planArtifactSizeError(0)).toBe("empty");
	});

	it("flags an oversized body just past the cap", () => {
		expect(planArtifactSizeError(MAX_PLAN_ARTIFACT_BYTES + 1)).toBe("too_large");
	});

	it("accepts a body at or under the cap", () => {
		expect(planArtifactSizeError(MAX_PLAN_ARTIFACT_BYTES)).toBeNull(); // boundary
		expect(planArtifactSizeError(3 * 1024 * 1024)).toBeNull();
	});

	it("pins the cap at 50 MiB", () => {
		expect(MAX_PLAN_ARTIFACT_BYTES).toBe(50 * 1024 * 1024);
	});
});
