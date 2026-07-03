// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-tenant memory isolation guard — the security-critical part of agent
// memory. These tests are the contract that one tenant can never escape its
// namespace into another's.

import { describe, expect, it } from "vitest";
import {
	memoryNamespace,
	resolveMemoryKey,
	safeMemoryPath,
} from "@/lib/agent/memory-path";

describe("memoryNamespace", () => {
	it("derives org and org/project namespaces", () => {
		expect(memoryNamespace("org-123")).toBe("org/org-123");
		expect(memoryNamespace("org-123", "proj-9")).toBe("org/org-123/project/proj-9");
	});

	it("rejects ids containing separators (namespace injection)", () => {
		expect(() => memoryNamespace("org/../other")).toThrow();
		expect(() => memoryNamespace("a b")).toThrow();
		expect(() => memoryNamespace("org-1", "../../x")).toThrow();
	});
});

describe("safeMemoryPath", () => {
	it("normalizes a clean path and strips the /memories mount", () => {
		expect(safeMemoryPath("notes/incident-1.md")).toBe("notes/incident-1.md");
		expect(safeMemoryPath("/memories/notes/x.md")).toBe("notes/x.md");
		expect(safeMemoryPath("memories/y.md")).toBe("y.md");
	});

	it.each([
		"../secret",
		"a/../../b",
		"/etc/passwd",
		"..",
		"a/..",
		"foo\\bar",
		"with\0null",
		"",
		"/",
		"./.",
	])("rejects traversal escape %j", (bad) => {
		expect(() => safeMemoryPath(bad)).toThrow();
	});
});

describe("resolveMemoryKey", () => {
	it("combines namespace + safe path", () => {
		const k = resolveMemoryKey("org-1", "proj-2", "/memories/facts/cluster.md");
		expect(k).toEqual({ namespace: "org/org-1/project/proj-2", path: "facts/cluster.md" });
	});

	it("a traversal attempt cannot escape the tenant namespace", () => {
		expect(() => resolveMemoryKey("org-1", null, "../../org-2/secrets")).toThrow();
	});
});
