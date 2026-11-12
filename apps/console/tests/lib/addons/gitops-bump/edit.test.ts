// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console half of the shared "only when sure" table (#6549). The Go half is
// packages/core/provisioner/addons_gitops_bump_fixture_test.go, over the SAME files, so the runner's
// drift check and this edit cannot come to disagree about a file without one of them failing.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bumpTargetRevision, isStrictSemver } from "@/lib/addons/gitops-bump/edit";

const FIXTURES = resolve(__dirname, "../../../../../../packages/core/provisioner/testdata/addon_bump");

interface BumpCase {
	name: string;
	file: string;
	drift: boolean;
	edit: string;
	expected?: string;
}
interface BumpTable {
	chart: string;
	target: string;
	cases: BumpCase[];
}

/** Narrows the parsed table; a malformed table fails the suite rather than passing it empty. */
function readTable(): BumpTable {
	const raw: unknown = JSON.parse(readFileSync(join(FIXTURES, "cases.json"), "utf8"));
	if (typeof raw !== "object" || raw === null || !("cases" in raw) || !Array.isArray(raw.cases)) {
		throw new Error("cases.json has no cases");
	}
	const chart = "chart" in raw && typeof raw.chart === "string" ? raw.chart : "";
	const target = "target" in raw && typeof raw.target === "string" ? raw.target : "";
	const cases: BumpCase[] = raw.cases.map((c: unknown) => {
		if (typeof c !== "object" || c === null) throw new Error("a case is not an object");
		const get = (k: string): unknown => (k in c ? Object.getOwnPropertyDescriptor(c, k)?.value : undefined);
		const name = get("name");
		const file = get("file");
		const drift = get("drift");
		const edit = get("edit");
		const expected = get("expected");
		if (typeof name !== "string" || typeof file !== "string" || typeof drift !== "boolean" || typeof edit !== "string") {
			throw new Error(`malformed case ${String(name)}`);
		}
		return { name, file, drift, edit, expected: typeof expected === "string" ? expected : undefined };
	});
	return { chart, target, cases };
}

const table = readTable();
const bytes = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

describe("bumpTargetRevision — the shared table (#6549)", () => {
	it("has cases, and every refusal kind the edit can return for a file is exercised", () => {
		expect(table.cases.length).toBeGreaterThan(20);
		const kinds = new Set(table.cases.map((c) => c.edit));
		for (const k of [
			"ok",
			"not-older",
			"revision-not-semver",
			"different-chart",
			"not-an-application",
			"not-yaml",
			"not-one-document",
			"multi-source",
			"revision-not-plain",
			"byte-order-mark",
			"not-utf8",
		]) {
			expect(kinds, `no case returns ${k}`).toContain(k);
		}
	});

	for (const c of table.cases) {
		it(`${c.name}: ${c.edit}`, () => {
			const result = bumpTargetRevision(bytes(c.file), table.chart, table.target);
			// An ok edit is compared byte for byte with the expected file: the one scalar changed,
			// nothing else. Base64 keeps the comparison exact, CR and invalid bytes included.
			const got = result.ok ? { ok: true, bytes: Buffer.from(result.bytes).toString("base64") } : result;
			const want =
				c.edit === "ok" && c.expected
					? { ok: true, bytes: Buffer.from(bytes(c.expected)).toString("base64") }
					: { ok: false, refusal: c.edit };
			expect(got).toEqual(want);
			// The table's invariant, asserted here too: never edit a file the runner does not report.
			expect(c.edit !== "ok" || c.drift).toBe(true);
		});
	}
});

describe("bumpTargetRevision — the splice", () => {
	it("changes exactly the version's bytes: the prefix and suffix are the original's", () => {
		const before = bytes("crlf-comments.yaml");
		const result = bumpTargetRevision(before, "ingress-nginx", "4.15.1");
		if (!result.ok) throw new Error(`refused: ${result.refusal}`);
		const a = Buffer.from(before).toString("utf8");
		const b = Buffer.from(result.bytes).toString("utf8");
		const at = a.indexOf("4.11.2");
		expect(b.slice(0, at)).toBe(a.slice(0, at));
		expect(b.slice(at + "4.15.1".length)).toBe(a.slice(at + "4.11.2".length));
		// CRLF survives: the same number of carriage returns, and no bare LF was introduced.
		expect(b.split("\r\n").length).toBe(a.split("\r\n").length);
		expect(b.replace(/\r\n/g, "").includes("\n")).toBe(false);
		// The end-of-line comment on the version itself is kept.
		expect(b).toContain("targetRevision: 4.15.1  # pinned until the Q3 window");
		expect(result.from).toBe("4.11.2");
	});

	it("reports the file's version as written, v prefix included", () => {
		const result = bumpTargetRevision(bytes("v-prefixed.yaml"), "ingress-nginx", "4.15.1");
		expect(result.ok ? result.from : result.refusal).toBe("v4.11.2");
	});

	it("refuses a target that is not a full SemVer version, before reading the file", () => {
		for (const to of ["4.15", "latest", "4.15.1 # x", "4.15.1\nkind: Secret", "v4.15.01"]) {
			expect(bumpTargetRevision(bytes("plain.yaml"), "ingress-nginx", to)).toEqual({
				ok: false,
				refusal: "target-not-semver",
			});
		}
	});

	it("refuses when the chart differs from the one asked for", () => {
		expect(bumpTargetRevision(bytes("plain.yaml"), "traefik", "4.15.1")).toEqual({ ok: false, refusal: "different-chart" });
	});
});

describe("isStrictSemver", () => {
	it("accepts full versions and rejects shorthand, ranges and leading zeros", () => {
		const good = ["1.2.3", "v1.2.3", "1.2.3-rc.1", "1.2.3+build.5", "0.0.0"];
		const bad = ["1.2", "1", "4.*", "01.2.3", "1.02.3", "1.2.3-", "1.2.3-01", " 1.2.3", ""];
		expect(good.filter((v) => !isStrictSemver(v))).toEqual([]);
		expect(bad.filter((v) => isStrictSemver(v))).toEqual([]);
	});
});
