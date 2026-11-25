// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The JSON Patch subset `apply_design_patch` accepts (lib/ai/mcp/json-patch.ts): add, remove and
// replace over RFC 6901 pointers, applied to a copy, all or none, with every unresolvable pointer
// returned as a problem naming the operation.

import { describe, expect, it } from "vitest";
import { applyJsonPatch, formatPointer, parsePointer } from "@/lib/ai/mcp/json-patch";

const DOC = { project: { region: "eu-west-1" }, databases: [{ name: "a" }, { name: "b" }], "a/b": { "c~d": 1 } };

describe("pointers", () => {
	it("parses and formats RFC 6901 pointers, escapes included", () => {
		expect(parsePointer("")).toEqual([]);
		expect(parsePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
		expect(parsePointer("no-slash")).toBeNull();
		expect(formatPointer(["a/b", "c~d", 0])).toBe("/a~1b/c~0d/0");
		expect(formatPointer([])).toBe("");
	});
});

describe("applyJsonPatch", () => {
	it("applies add, remove and replace in order, on a copy", () => {
		const result = applyJsonPatch(DOC, [
			{ op: "replace", path: "/project/region", value: "eu-central-1" },
			{ op: "add", path: "/databases/-", value: { name: "c" } },
			{ op: "add", path: "/databases/0", value: { name: "z" } },
			{ op: "remove", path: "/databases/1" },
			{ op: "replace", path: "/databases/0", value: { name: "y" } },
			{ op: "add", path: "/project/tags", value: ["x"] },
			{ op: "remove", path: "/a~1b/c~0d" },
		]);
		expect(result).toEqual({
			ok: true,
			document: { project: { region: "eu-central-1", tags: ["x"] }, databases: [{ name: "y" }, { name: "b" }, { name: "c" }], "a/b": {} },
		});
		expect(DOC.project.region).toBe("eu-west-1");
	});

	it("applies none of a patch whose later operation fails", () => {
		const result = applyJsonPatch(DOC, [
			{ op: "replace", path: "/project/region", value: "x" },
			{ op: "remove", path: "/missing" },
		]);
		expect(result).toEqual({
			ok: false,
			problem: { path: "/missing", code: "path_not_found", message: "Operation 1 (remove): nothing at missing to remove.", fix: null },
		});
	});

	it("refuses pointers that do not resolve, with a code for each reason", () => {
		const codeOf = (operation: Parameters<typeof applyJsonPatch>[1][number]) => {
			const result = applyJsonPatch(DOC, [operation]);
			return result.ok ? "ok" : result.problem.code;
		};
		expect(codeOf({ op: "remove", path: "databases" })).toBe("invalid_pointer");
		expect(codeOf({ op: "replace", path: "", value: {} })).toBe("invalid_pointer");
		expect(codeOf({ op: "add", path: "/project/x" })).toBe("missing_value");
		expect(codeOf({ op: "add", path: "/__proto__/polluted", value: true })).toBe("invalid_pointer");
		expect(codeOf({ op: "add", path: "/project/constructor", value: 1 })).toBe("invalid_pointer");
		expect(codeOf({ op: "replace", path: "/nope/x", value: 1 })).toBe("path_not_found");
		expect(codeOf({ op: "replace", path: "/databases/9/name", value: 1 })).toBe("path_not_found");
		expect(codeOf({ op: "replace", path: "/databases/01", value: 1 })).toBe("path_not_found");
		expect(codeOf({ op: "replace", path: "/databases/-", value: 1 })).toBe("path_not_found");
		expect(codeOf({ op: "replace", path: "/databases/2", value: 1 })).toBe("path_not_found");
		expect(codeOf({ op: "add", path: "/project/region/x", value: 1 })).toBe("path_not_found");
		expect(codeOf({ op: "replace", path: "/project/nope", value: 1 })).toBe("path_not_found");
		expect(codeOf({ op: "replace", path: "/databases/0/name/x", value: 1 })).toBe("path_not_found");
		expect(codeOf({ op: "replace", path: "/databases/1/name", value: "bb" })).toBe("ok");
	});
});
