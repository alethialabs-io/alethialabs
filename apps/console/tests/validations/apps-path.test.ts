// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Locks the TS apps_path grammar (#1767) to the Go one it mirrors
// (packages/core/argocd.ValidateAppsPath). A value the console accepts and the runner refuses is a
// deploy that dies late; a value the console refuses and the runner would have accepted is a knob
// the user can never reach. Both directions are failures, so the tables below are the Go test's
// tables (apps_path_test.go) case-for-case, not an invented subset.

import { describe, expect, it } from "vitest";
import { appsPathSchema, goTrimSpace, isValidAppsPath } from "@/lib/validations/apps-path";

describe("isValidAppsPath — accepts (mirrors the Go `valid` table)", () => {
	it.each([
		["", "empty means the repository root — the pre-column behaviour"],
		[".", "explicit repository root"],
		["   ", "whitespace only is still the repository root"],
		["manifests", "a single segment"],
		["overlays/dev", "the canonical per-tier overlay"],
		["k8s/overlays/staging", "a deeper layout"],
		["k8s/overlays/prod-eu", "nested, with a hyphen"],
		["a.b_c-d/e.f", "dots, underscores and dashes inside a segment"],
		["apps_v2/dev.1", "underscore and dot inside a segment"],
		["v2/overlays/dev", "a numeric segment"],
		["a", "a single character"],
	])("accepts %j (%s)", (value) => {
		expect(isValidAppsPath(value)).toBe(true);
	});
});

describe("isValidAppsPath — rejects (mirrors the Go `invalid` table)", () => {
	it.each([
		// Repo-root escape — the reason this guard exists.
		["..", "bare traversal"],
		["../etc", "leading traversal"],
		["../../etc", "traversal — REFUSED, never normalised to 'etc'"],
		["overlays/../../etc", "traversal in the middle"],
		["overlays/../dev", "traversal that normalises back INSIDE the repo"],
		["/abs/path", "absolute — ArgoCD resolves it outside the repo"],
		["/", "absolute root"],
		["/overlays/dev", "absolute overlay"],
		// Non-canonical forms: refused rather than silently rewritten.
		["overlays/dev/", "trailing slash"],
		["overlays//dev", "double slash — empty segment"],
		["./overlays/dev", "leading dot segment"],
		["overlays/./dev", "dot segment in the middle"],
		["overlays/.", "trailing dot segment"],
		// YAML-scalar escape from `path: '{{ .AppsPath }}'`.
		["over'lays", "single quote"],
		["overlays/'dev'", "quoted segment — breaks out of the YAML scalar"],
		['over"lays', "double quote"],
		["over`lays`", "backtick"],
		["$(whoami)", "dollar expansion"],
		["overlays/$(id)", "shell-ish runes are excluded by construction"],
		["${HOME}", "brace expansion"],
		["over lays", "space"],
		["overlays/my dev", "space in a later segment"],
		["overlays\ndev", "newline"],
		["overlays/dev\nfoo: bar", "newline — injects a YAML key"],
		["overlays\rdev", "carriage return"],
		["overlays\tdev", "tab inside"],
		["overlays:dev", "colon"],
		["-overlays", "segment starting with a dash"],
		["-overlays/dev", "later segment must start alphanumeric"],
		[".hidden/dev", "segment starting with a dot"],
	])("rejects %j (%s)", (value) => {
		expect(isValidAppsPath(value)).toBe(false);
	});

	it("rejects a path past the 512-char scalar bound", () => {
		expect(isValidAppsPath("a".repeat(512))).toBe(true);
		expect(isValidAppsPath("a".repeat(513))).toBe(false);
	});
});

// The whole point of a mirror is that it agrees at the EDGES too. These three cases were found by
// running this grammar and the real Go function over a shared corpus: `String.prototype.trim()`
// and Go's `strings.TrimSpace` disagree on exactly two code points, and one of them fails OPEN.
describe("isValidAppsPath — the trim set is Go's, not JavaScript's", () => {
	it("rejects a U+FEFF-prefixed path, because Go does not treat the BOM as space", () => {
		// String.prototype.trim() strips U+FEFF, so a `.trim()`-based mirror ACCEPTED this and the
		// runner then refused it — a deploy that dies late off an invisible pasted character.
		expect(isValidAppsPath("\uFEFFoverlays/dev")).toBe(false);
		expect(isValidAppsPath("overlays/dev\uFEFF")).toBe(false);
		expect(isValidAppsPath("\uFEFF")).toBe(false);
	});

	it("accepts a U+0085-wrapped path, because Go's unicode.IsSpace trims NEL", () => {
		// The opposite failure: `.trim()` leaves U+0085 in place, so the console refused a value the
		// runner would have accepted — a knob the user cannot reach.
		expect(isValidAppsPath("\u0085overlays/dev")).toBe(true);
		expect(isValidAppsPath("overlays/dev\u0085")).toBe(true);
		expect(isValidAppsPath("\u0085")).toBe(true);
	});

	it.each([
		["\u00A0overlays/dev", "U+00A0 NBSP"],
		["\u2003overlays/dev", "U+2003 EM SPACE"],
		["\u3000overlays/dev", "U+3000 IDEOGRAPHIC SPACE"],
		["\u2028overlays/dev", "U+2028 LINE SEPARATOR"],
	])("trims %j (%s) — both sides do", (value) => {
		expect(isValidAppsPath(value)).toBe(true);
	});

	it("does NOT trim U+200B, which neither side treats as space", () => {
		expect(goTrimSpace("\u200Boverlays/dev")).toBe("\u200Boverlays/dev");
		expect(isValidAppsPath("\u200Boverlays/dev")).toBe(false);
	});
});

describe("appsPathSchema", () => {
	it("accepts null and undefined — the column is nullable and unset means the root", () => {
		expect(appsPathSchema.safeParse(null).success).toBe(true);
		expect(appsPathSchema.safeParse(undefined).success).toBe(true);
	});

	// #1767's load-bearing invariant: the schema must never manufacture a value. A `.default("")`
	// here would put `apps_path` on every config snapshot and break byte-identity for every deploy
	// that predates the column.
	it("never defaults — undefined parses to undefined, null to null", () => {
		const undef = appsPathSchema.safeParse(undefined);
		expect(undef.success && undef.data).toBeUndefined();
		const nul = appsPathSchema.safeParse(null);
		expect(nul.success && nul.data).toBeNull();
	});

	it("trims surrounding whitespace but does not rewrite the path", () => {
		const parsed = appsPathSchema.safeParse("  overlays/dev  ");
		expect(parsed.success && parsed.data).toBe("overlays/dev");
	});

	it("stores the value the guard judged — the trim is Go's, so U+0085 is stripped", () => {
		const parsed = appsPathSchema.safeParse("\u0085overlays/dev\u0085");
		expect(parsed.success && parsed.data).toBe("overlays/dev");
	});

	it("normalises whitespace-only to '' — falsy, so the snapshot key stays ABSENT", () => {
		const parsed = appsPathSchema.safeParse("   ");
		expect(parsed.success && parsed.data).toBe("");
	});

	it("rejects a traversal with a message that names the expected shape", () => {
		const parsed = appsPathSchema.safeParse("../../shared");
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.issues[0]?.message).toContain("overlays/dev");
		}
	});

	it("rejects a BOM-prefixed path rather than handing the runner a value it will refuse", () => {
		expect(appsPathSchema.safeParse("\uFEFFoverlays/dev").success).toBe(false);
	});
});
