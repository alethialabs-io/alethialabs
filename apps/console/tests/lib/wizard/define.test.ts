// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What a wizard declaration is held to (lib/wizard/define.ts).
//
// The first half is the draft allowlist: which schemas may be stored, and that every other one is
// refused when the definition is declared — not later, and not only by a test. Each refused shape
// below is one that could carry a value nobody listed.
//
// The second half is completeness: every key of the submit schema owned by exactly one step.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	assertWizardComplete,
	defineWizard,
	draftSchemaProblems,
	draftTopLevelKeys,
	isWizardDefinition,
	sensitiveDraftKeys,
	submitSchemaKeys,
} from "@/lib/wizard/define";
import type { WizardDefinition, WizardDraft, WizardStep } from "@/lib/wizard/types";
import { examplePoolWizard } from "./fixtures/example.wizard";

/** The values of the small wizard these tests declare. */
interface OrgValues {
	name: string;
	slug: string;
}

const orgSchema = z.object({ name: z.string().min(1), slug: z.string().min(1) });

/** A complete two-step wizard, with `overrides` laid over it. */
function orgWizard(
	overrides: Partial<WizardDefinition<OrgValues, OrgValues>> = {},
): WizardDefinition<OrgValues, OrgValues> {
	return {
		id: "create-org",
		presentation: "overlay",
		schema: orgSchema,
		steps: [
			{ id: "name", label: "Name", fields: ["name"], schema: z.object({ name: z.string().min(1) }) },
			{ id: "slug", label: "Address", fields: ["slug"], schema: z.object({ slug: z.string().min(1) }) },
		],
		draft: null,
		...overrides,
	};
}

/** A draft over `schema`, version 1, kept an hour. */
function draftOf(schema: z.ZodType): WizardDraft {
	return { version: 1, ttlMinutes: 60, schema };
}

describe("draftSchemaProblems — what may be stored", () => {
	it("accepts an object of plain values, wrapped or nested", () => {
		const schema = z.object({
			name: z.string(),
			count: z.number().optional(),
			enabled: z.boolean().default(false),
			plan: z.enum(["community", "pro"]),
			kind: z.literal("git").nullable(),
			tags: z.array(z.string()),
			source: z.union([z.literal("git"), z.literal("oci")]),
			placement: z.object({ region: z.string(), zones: z.array(z.string()).readonly() }),
			strict: z.strictObject({ ref: z.string() }),
		});
		expect(draftSchemaProblems(schema)).toEqual([]);
	});

	it("refuses a schema that is not an object, because its keys cannot be listed", () => {
		expect(draftSchemaProblems(z.string())).toHaveLength(1);
		expect(draftSchemaProblems(z.record(z.string(), z.string()))).toHaveLength(1);
		expect(draftSchemaProblems(z.any())).toHaveLength(1);
		expect(draftSchemaProblems(z.object({ a: z.string() }).transform((v) => v))).toHaveLength(1);
	});

	it("refuses an object that keeps keys it does not name", () => {
		expect(draftSchemaProblems(z.looseObject({ name: z.string() }))).toHaveLength(1);
		expect(draftSchemaProblems(z.object({ name: z.string() }).catchall(z.string()))).toHaveLength(1);
		expect(
			draftSchemaProblems(z.object({ inner: z.looseObject({ name: z.string() }) })),
		).toHaveLength(1);
	});

	it.each([
		["any", z.any()],
		["unknown", z.unknown()],
		["record", z.record(z.string(), z.string())],
		["custom", z.custom<File>()],
		["file", z.file()],
		["date", z.date()],
		["transform", z.string().transform((value) => value.trim())],
		["array of unknown", z.array(z.unknown())],
		["union with an open branch", z.union([z.string(), z.unknown()])],
	])("refuses a %s value, at any depth", (_name, value) => {
		expect(draftSchemaProblems(z.object({ field: value }))).toHaveLength(1);
		expect(draftSchemaProblems(z.object({ outer: z.object({ field: value }) }))).toEqual([
			expect.stringContaining("outer.field"),
		]);
	});

	it("lists the top-level keys of an object schema and nothing for another schema", () => {
		expect(draftTopLevelKeys(z.object({ name: z.string(), slug: z.string() }))).toEqual(["name", "slug"]);
		expect(draftTopLevelKeys(z.string())).toBeNull();
	});
});

describe("defineWizard — refuses an unsafe draft when the definition is declared", () => {
	it("returns the definition it was given when there is nothing to refuse", () => {
		const definition = orgWizard({ draft: draftOf(z.object({ name: z.string(), slug: z.string() })) });
		expect(defineWizard(definition)).toBe(definition);
		expect(defineWizard(orgWizard())).toMatchObject({ draft: null });
	});

	it("throws for a draft schema that is not an allowlist", () => {
		expect(() => defineWizard(orgWizard({ draft: draftOf(z.any()) }))).toThrow(/create-org/);
		expect(() =>
			defineWizard(orgWizard({ draft: draftOf(z.looseObject({ name: z.string() })) })),
		).toThrow(/does not name/);
		expect(() =>
			defineWizard(orgWizard({ draft: draftOf(z.object({ name: z.unknown() })) })),
		).toThrow(/cannot be kept in a draft/);
	});

	it("throws for a version or a lifetime that is not usable", () => {
		const schema = z.object({ name: z.string() });
		expect(() => defineWizard(orgWizard({ draft: { version: 0, ttlMinutes: 60, schema } }))).toThrow(
			/version/,
		);
		expect(() => defineWizard(orgWizard({ draft: { version: 1.5, ttlMinutes: 60, schema } }))).toThrow(
			/version/,
		);
		expect(() => defineWizard(orgWizard({ draft: { version: 1, ttlMinutes: 0, schema } }))).toThrow(
			/ttlMinutes/,
		);
		expect(() =>
			defineWizard(orgWizard({ draft: { version: 1, ttlMinutes: Number.POSITIVE_INFINITY, schema } })),
		).toThrow(/ttlMinutes/);
	});

	it("throws for ids that cannot go in a URL, repeat, or are missing", () => {
		expect(() => defineWizard(orgWizard({ id: "create org" }))).toThrow(/URL identifier/);
		expect(() => defineWizard(orgWizard({ steps: [] }))).toThrow(/no steps/);
		const [first] = orgWizard().steps;
		if (first === undefined) throw new Error("the fixture has steps");
		expect(() => defineWizard(orgWizard({ steps: [first, first] }))).toThrow(/used twice/);
		expect(() => defineWizard(orgWizard({ steps: [{ ...first, id: "a/b" }] }))).toThrow(
			/URL identifier/,
		);
	});
});

describe("sensitiveDraftKeys — the name heuristic", () => {
	it.each(["apiToken", "clientSecret", "password", "accessKey", "cardNumber", "cvc", "iban", "API_KEY"])(
		"flags %s",
		(name) => {
			expect(sensitiveDraftKeys(z.object({ [name]: z.string() }))).toEqual([name]);
		},
	);

	it("flags a nested key by its full path, through wrappers, arrays and unions", () => {
		const schema = z.object({
			storage: z.object({ secretKey: z.string() }).optional(),
			hooks: z.array(z.object({ token: z.string() })),
			auth: z.union([z.object({ password: z.string() }), z.object({ user: z.string() })]),
		});
		expect(sensitiveDraftKeys(schema).sort()).toEqual([
			"auth.password",
			"hooks.token",
			"storage.secretKey",
		]);
	});

	it("flags nothing in a schema of identifiers", () => {
		expect(sensitiveDraftKeys(z.object({ name: z.string(), roleArn: z.string(), projectId: z.string() }))).toEqual(
			[],
		);
		expect(sensitiveDraftKeys(z.string())).toEqual([]);
	});
});

describe("submitSchemaKeys", () => {
	it("reads an object, a refined object and a transformed object", () => {
		expect(submitSchemaKeys(orgSchema)).toEqual(["name", "slug"]);
		expect(submitSchemaKeys(orgSchema.refine(() => true))).toEqual(["name", "slug"]);
		expect(submitSchemaKeys(orgSchema.transform((v) => ({ title: v.name })))).toEqual(["name", "slug"]);
		expect(submitSchemaKeys(orgSchema.readonly())).toEqual(["name", "slug"]);
	});

	it("reads every branch of a union and an intersection", () => {
		const union = z.discriminatedUnion("source", [
			z.object({ source: z.literal("git"), repo: z.string() }),
			z.object({ source: z.literal("oci"), registry: z.string() }),
		]);
		expect(submitSchemaKeys(union)).toEqual(["source", "repo", "registry"]);
		expect(
			submitSchemaKeys(z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))),
		).toEqual(["a", "b"]);
	});

	it("answers null when the keys cannot be read", () => {
		expect(submitSchemaKeys(z.string())).toBeNull();
		expect(submitSchemaKeys(z.union([orgSchema, z.string()]))).toBeNull();
	});
});

describe("assertWizardComplete", () => {
	it("passes a wizard whose steps own every key once", () => {
		expect(() => assertWizardComplete(orgWizard())).not.toThrow();
		expect(() => assertWizardComplete(examplePoolWizard)).not.toThrow();
	});

	it("fails when a key of the submit schema is owned by no step", () => {
		const [first] = orgWizard().steps;
		if (first === undefined) throw new Error("the fixture has steps");
		expect(() => assertWizardComplete(orgWizard({ steps: [first] }))).toThrow(
			/"slug" is in the submit schema and owned by no step/,
		);
	});

	it("fails when a key is owned by two steps", () => {
		const both: WizardStep<OrgValues>["fields"] = ["name", "slug"];
		const steps = orgWizard().steps.map((step) => ({ ...step, fields: both }));
		expect(() => assertWizardComplete(orgWizard({ steps }))).toThrow(/owned by step "name" and/);
	});

	it("fails when a step owns a field the submit schema does not have", () => {
		const schema = z.object({ name: z.string() });
		const definition: WizardDefinition<Record<string, string>, Record<string, string>> = {
			id: "stale-field",
			presentation: "page",
			schema,
			steps: [{ id: "name", label: "Name", fields: ["name", "slug"], schema }],
			draft: null,
		};
		expect(() => assertWizardComplete(definition)).toThrow(/which the submit schema does not have/);
	});

	it("fails when the submit schema's keys cannot be read", () => {
		const schema: z.ZodType<OrgValues, OrgValues> = z.custom<OrgValues>();
		expect(() => assertWizardComplete(orgWizard({ schema }))).toThrow(/cannot be read/);
	});

	it("fails when the draft keeps a key the submit schema does not have", () => {
		const draft = draftOf(z.object({ name: z.string(), nickname: z.string() }));
		expect(() => assertWizardComplete(orgWizard({ draft }))).toThrow(/the draft keeps "nickname"/);
	});

	it("fails for an unsafe draft as defineWizard does", () => {
		expect(() => assertWizardComplete(orgWizard({ draft: draftOf(z.any()) }))).toThrow(/z\.object/);
	});

	it("treats a nested field and its parent in two steps as owned twice", () => {
		interface Nested {
			placement: { region: string; zone: string };
		}
		const schema = z.object({ placement: z.object({ region: z.string(), zone: z.string() }) });
		const split: WizardDefinition<Nested, Nested> = {
			id: "nested",
			presentation: "page",
			schema,
			steps: [
				{ id: "region", label: "Region", fields: ["placement.region"], schema },
				{ id: "zone", label: "Zone", fields: ["placement.zone"], schema },
			],
			draft: null,
		};
		expect(() => assertWizardComplete(split)).not.toThrow();
		const overlapping: WizardDefinition<Nested, Nested> = {
			...split,
			steps: [
				{ id: "region", label: "Region", fields: ["placement"], schema },
				{ id: "zone", label: "Zone", fields: ["placement.zone"], schema },
			],
		};
		expect(() => assertWizardComplete(overlapping)).toThrow(/owned by step "region"/);
	});
});

describe("isWizardDefinition", () => {
	it("recognises a definition and nothing else", () => {
		expect(isWizardDefinition(examplePoolWizard)).toBe(true);
		expect(isWizardDefinition(orgWizard())).toBe(true);
		expect(isWizardDefinition(null)).toBe(false);
		expect(isWizardDefinition("create-org")).toBe(false);
		expect(isWizardDefinition({ id: "x" })).toBe(false);
		expect(isWizardDefinition({ ...orgWizard(), presentation: "modal" })).toBe(false);
		expect(isWizardDefinition({ ...orgWizard(), schema: {} })).toBe(false);
		expect(isWizardDefinition({ ...orgWizard(), steps: null })).toBe(false);
		expect(isWizardDefinition({ ...orgWizard(), id: 7 })).toBe(false);
	});
});
