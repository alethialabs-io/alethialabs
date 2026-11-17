// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's vocabulary table, held to itself (CON-SM9, #6760).
//
// What this pins: the table is well formed, a word cannot be both a label and a rejected word,
// the console differs from the docs glossary's term for exactly one concept (CON-M3), and the
// labels the jobs catalog already prints are the ones the vocabulary exports.
//
// What it does NOT pin: that any screen imports a label, and that a `glossary:` value still
// matches `apps/docs/content/docs/reference/glossary.mdx`. This file reads nothing outside the
// console package.

import { describe, expect, it } from "vitest";

import {
	ARCHITECTURE,
	ASSISTANT,
	AUTH,
	CLOUD_ACCOUNT,
	CONNECTOR,
	FABRIC,
	IN_FLIGHT,
	JOB_ACTION,
	ORGANIZATION,
	PROJECT,
	VOCABULARY,
	type VocabularyRow,
	sentenceStart,
} from "@/lib/copy/vocabulary";
import { JOB_TYPES } from "@/lib/jobs/format";

/** The table at its declared row type, so a row's words read as strings rather than literals. */
const ROWS: readonly VocabularyRow[] = VOCABULARY;

/** Every label the table carries, across all rows. */
function allLabels(): string[] {
	return ROWS.flatMap((row) => [...row.labels]);
}

describe("the table", () => {
	it("has one row per concept of the spec's table, each with a unique id", () => {
		const ids = ROWS.map((row) => row.id);
		expect(ids).toEqual([
			"project",
			"cloud-account",
			"connector",
			"architecture",
			"assistant",
			"job-action",
			"in-flight",
			"fabric",
			"auth",
			"tenancy",
		]);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("gives every row at least one label, and no empty word anywhere", () => {
		const unlabelled = ROWS.filter((row) => row.labels.length === 0).map((row) => row.id);
		const malformed = ROWS.flatMap((row) =>
			[...row.labels, ...row.not].filter((word) => word === "" || word.trim() !== word).map((word) => `${row.id}: "${word}"`),
		);
		expect(unlabelled).toEqual([]);
		expect(malformed).toEqual([]);
	});

	it("never lists a word as a label in one row and as rejected in any row", () => {
		const rejected = new Set(ROWS.flatMap((row) => [...row.not]));
		expect(allLabels().filter((label) => rejected.has(label))).toEqual([]);
	});

	it("carries every exported label, so an export cannot sit outside the table", () => {
		const exported = [
			...Object.values(PROJECT),
			...Object.values(CLOUD_ACCOUNT),
			...Object.values(CONNECTOR),
			...Object.values(ORGANIZATION),
			ARCHITECTURE,
			ASSISTANT,
			FABRIC.label,
			...Object.values(JOB_ACTION),
			...Object.values(IN_FLIGHT),
			...Object.values(AUTH),
		];
		expect([...exported].sort()).toEqual([...allLabels()].sort());
	});
});

describe("the console and the docs glossary", () => {
	it("differ for exactly one concept: a cloud identity is a cloud account on screen", () => {
		const differing = ROWS.filter(
			(row) => row.glossary !== null && !row.labels.some((label) => label === row.glossary),
		).map((row) => ({ id: row.id, glossary: row.glossary, label: row.labels[0] }));
		expect(differing).toEqual([{ id: "cloud-account", glossary: "cloud identity", label: "cloud account" }]);
	});

	it("rejects the bare word for a connected account", () => {
		const row = ROWS.find((r) => r.id === "cloud-account");
		expect(row?.not).toContain("identity");
		expect(row?.not).toContain("integration");
	});
});

describe("labels the console already prints", () => {
	it("are the jobs catalog's Plan, Deploy and Destroy", () => {
		expect(JOB_TYPES.PLAN.label).toBe(JOB_ACTION.plan);
		expect(JOB_TYPES.DEPLOY.label).toBe(JOB_ACTION.deploy);
		expect(JOB_TYPES.DESTROY.label).toBe(JOB_ACTION.destroy);
	});
});

describe("Fabric", () => {
	it("comes with a one-line definition that does not lean on the word itself", () => {
		expect(FABRIC.label).toBe("Fabric");
		expect(FABRIC.definition).not.toContain("\n");
		expect(FABRIC.definition.endsWith(".")).toBe(true);
		expect(FABRIC.definition.toLowerCase()).not.toContain("fabric");
	});

	it("rejects the lowercase form", () => {
		expect(ROWS.find((r) => r.id === "fabric")?.not).toEqual(["fabric"]);
	});
});

describe("sentenceStart", () => {
	it("raises the first letter and leaves the rest alone", () => {
		expect(sentenceStart(CLOUD_ACCOUNT.one)).toBe("Cloud account");
		expect(sentenceStart(ORGANIZATION.many)).toBe("Organizations");
		expect(sentenceStart(AUTH.signIn)).toBe("Sign in");
	});

	it("returns an empty string unchanged", () => {
		expect(sentenceStart("")).toBe("");
	});
});
