// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	inferredNeedSchema,
	inferredStackSchema,
} from "@/lib/scanner/schema";

describe("inferredNeedSchema", () => {
	it("accepts a well-formed need", () => {
		const r = inferredNeedSchema.safeParse({
			kind: "database",
			engine: "postgresql",
			confidence: 0.8,
			rationale: "found a DATABASE_URL",
		});
		expect(r.success).toBe(true);
	});

	it("rejects an unknown kind", () => {
		expect(
			inferredNeedSchema.safeParse({ kind: "blockchain", confidence: 1, rationale: "x" }).success,
		).toBe(false);
	});

	it("bounds confidence to 0..1 and requires a rationale", () => {
		expect(inferredNeedSchema.safeParse({ kind: "cache", confidence: 1.5, rationale: "x" }).success).toBe(false);
		expect(inferredNeedSchema.safeParse({ kind: "cache", confidence: 0.5 }).success).toBe(false);
	});
});

describe("inferredStackSchema", () => {
	const base = {
		runtime: "node",
		summary: "A web app needing a database.",
		container: { dockerfile: true },
		needs: [],
	};

	it("accepts a minimal stack and defaults scale to small", () => {
		const r = inferredStackSchema.safeParse(base);
		expect(r.success).toBe(true);
		if (r.success) expect(r.data.scale).toBe("small");
	});

	it("requires runtime + summary + container", () => {
		expect(inferredStackSchema.safeParse({ ...base, runtime: undefined }).success).toBe(false);
		expect(inferredStackSchema.safeParse({ ...base, container: undefined }).success).toBe(false);
	});
});
