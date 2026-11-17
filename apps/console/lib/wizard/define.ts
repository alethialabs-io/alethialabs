// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Declaring a wizard, and the two questions asked of every declaration.
//
// 1. IS THE DRAFT SCHEMA AN ALLOWLIST? `defineWizard` answers this when the module loads and
//    throws when the answer is no, so a definition that could keep more than it lists never
//    reaches a component. "An allowlist" is a structural property, read off the schema:
//      - it is a `z.object`, so its keys can be enumerated;
//      - it has no catchall, so a key it does not name is dropped rather than kept;
//      - every value is plain data all the way down — strings, numbers, booleans, enums,
//        literals, null, and arrays, objects and unions of those. `z.any()`, `z.unknown()`,
//        `z.record()`, `z.custom()` and anything that transforms are refused, because each of
//        them can carry a value nobody listed (a `File`, a nested object, a whole sub-form).
//    A schema type this file does not recognise is refused. That is the direction the default
//    has to point: a new zod type starts out not storable.
//
// 2. IS THE WIZARD COMPLETE? `assertWizardComplete` answers this in a test that walks every
//    `*.wizard.ts`. A key of the submit schema owned by no step is a field that can fail on
//    submit with nowhere to show the message; one owned by two steps has two places to send the
//    user. Both are refused, and so is a step field the submit schema does not have.
//
// `sensitiveDraftKeys` is a third, weaker reading: a NAME match on the draft's keys. It is a
// second pair of eyes for the same test, not the control — the control is that a field has to be
// listed, on purpose, to be kept at all.

import type { FieldValues } from "react-hook-form";
import { z } from "zod";
import { isViewId } from "@/lib/query/view-url-params";
import type { WizardDefinition } from "@/lib/wizard/types";

/** Any zod schema, as far as reading its structure goes. */
type AnySchema = z.core.SomeType;

/** The value types a draft may hold as they are. */
const PLAIN_VALUE_TYPES: ReadonlySet<string> = new Set([
	"string",
	"number",
	"boolean",
	"enum",
	"literal",
	"null",
]);

/** Key names that suggest a credential or a payment detail. A heuristic for the definitions test. */
const SENSITIVE_KEY_NAME = /token|secret|password|key|card|cvc|iban/i;

/** The schema behind an optional, nullable, defaulted or readonly wrapper, or `null` for anything else. */
function unwrapped(schema: AnySchema): AnySchema | null {
	if (schema instanceof z.core.$ZodOptional) return schema._zod.def.innerType;
	if (schema instanceof z.core.$ZodNullable) return schema._zod.def.innerType;
	if (schema instanceof z.core.$ZodDefault) return schema._zod.def.innerType;
	if (schema instanceof z.core.$ZodReadonly) return schema._zod.def.innerType;
	return null;
}

/** `path` extended by `key`. */
function joinPath(path: string, key: string): string {
	return path === "" ? key : `${path}.${key}`;
}

/** Why a draft object schema is not an allowlist: a catchall, or a value that is not plain data. */
function objectProblems(schema: z.core.$ZodObject, path: string): string[] {
	const problems: string[] = [];
	const catchall = schema._zod.def.catchall;
	if (catchall !== undefined && catchall._zod.def.type !== "never") {
		problems.push(
			`${path === "" ? "the draft schema" : path} keeps keys it does not name (a catchall or a loose object)`,
		);
	}
	for (const [key, child] of Object.entries(schema._zod.def.shape)) {
		problems.push(...valueProblems(child, joinPath(path, key)));
	}
	return problems;
}

/** Why the value at `path` cannot be kept in a draft; empty when it is plain data. */
function valueProblems(schema: AnySchema, path: string): string[] {
	const type = schema._zod.def.type;
	if (PLAIN_VALUE_TYPES.has(type)) return [];
	const inner = unwrapped(schema);
	if (inner !== null) return valueProblems(inner, path);
	if (schema instanceof z.core.$ZodArray) return valueProblems(schema._zod.def.element, path);
	if (schema instanceof z.core.$ZodObject) return objectProblems(schema, path);
	if (schema instanceof z.core.$ZodUnion) {
		return schema._zod.def.options.flatMap((option) => valueProblems(option, path));
	}
	return [`${path}: a "${type}" value cannot be kept in a draft`];
}

/**
 * Why `schema` is not a draft allowlist. Empty when it is one: an object schema with no catchall
 * whose every value is plain data.
 */
export function draftSchemaProblems(schema: AnySchema): string[] {
	if (!(schema instanceof z.core.$ZodObject)) {
		return ["the draft schema must be a z.object, so the keys it keeps can be listed"];
	}
	return objectProblems(schema, "");
}

/** The top-level keys a draft schema keeps, or `null` when it is not an object schema. */
export function draftTopLevelKeys(schema: AnySchema): readonly string[] | null {
	if (!(schema instanceof z.core.$ZodObject)) return null;
	return Object.keys(schema._zod.def.shape);
}

/** Every key path under `schema`, through wrappers, arrays, unions and nested objects. */
function keyPaths(schema: AnySchema, path: string): string[] {
	const inner = unwrapped(schema);
	if (inner !== null) return keyPaths(inner, path);
	if (schema instanceof z.core.$ZodArray) return keyPaths(schema._zod.def.element, path);
	if (schema instanceof z.core.$ZodUnion) {
		return schema._zod.def.options.flatMap((option) => keyPaths(option, path));
	}
	if (schema instanceof z.core.$ZodObject) {
		return Object.entries(schema._zod.def.shape).flatMap(([key, child]) => {
			const here = joinPath(path, key);
			return [here, ...keyPaths(child, here)];
		});
	}
	return [];
}

/**
 * The draft key paths whose NAME suggests a credential or a payment detail. A name heuristic for
 * the definitions test to refuse; it is not what keeps such a field out of a draft.
 */
export function sensitiveDraftKeys(schema: AnySchema): string[] {
	const found = new Set<string>();
	for (const path of keyPaths(schema, "")) {
		const name = path.split(".").pop() ?? path;
		if (SENSITIVE_KEY_NAME.test(name)) found.add(path);
	}
	return [...found];
}

/**
 * The top-level keys of a submit schema, or `null` when they cannot be read off it. Reads through
 * a transform to its input, and across a union or an intersection to every branch.
 */
export function submitSchemaKeys(schema: AnySchema): readonly string[] | null {
	if (schema instanceof z.core.$ZodObject) return Object.keys(schema._zod.def.shape);
	if (schema instanceof z.core.$ZodPipe) return submitSchemaKeys(schema._zod.def.in);
	const inner = unwrapped(schema);
	if (inner !== null) return submitSchemaKeys(inner);
	const branches: readonly AnySchema[] | null =
		schema instanceof z.core.$ZodUnion
			? schema._zod.def.options
			: schema instanceof z.core.$ZodIntersection
				? [schema._zod.def.left, schema._zod.def.right]
				: null;
	if (branches === null) return null;
	const keys = new Set<string>();
	for (const branch of branches) {
		const branchKeys = submitSchemaKeys(branch);
		if (branchKeys === null) return null;
		for (const key of branchKeys) keys.add(key);
	}
	return [...keys];
}

/** The first segment of a field path: the submit-schema key it belongs to. */
function topLevelKey(field: string): string {
	return field.split(".")[0] ?? field;
}

/** Whether two field paths name the same field, or one names a parent of the other. */
function overlaps(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/** Why a definition's draft is not safe to store; empty for `draft: null` and for an allowlist. */
function draftProblems<V extends FieldValues, TOut>(definition: WizardDefinition<V, TOut>): string[] {
	const draft = definition.draft;
	if (draft === null) return [];
	const problems = draftSchemaProblems(draft.schema);
	if (!Number.isInteger(draft.version) || draft.version < 1) {
		problems.push("draft.version must be a positive integer");
	}
	if (!Number.isFinite(draft.ttlMinutes) || draft.ttlMinutes <= 0) {
		problems.push("draft.ttlMinutes must be greater than zero");
	}
	return problems;
}

/** Why a definition's ids cannot be used in a URL or as a storage namespace. */
function idProblems<V extends FieldValues, TOut>(definition: WizardDefinition<V, TOut>): string[] {
	const problems: string[] = [];
	if (!isViewId(definition.id)) problems.push(`the wizard id "${definition.id}" is not a URL identifier`);
	if (definition.steps.length === 0) problems.push("the wizard has no steps");
	const seen = new Set<string>();
	for (const step of definition.steps) {
		if (!isViewId(step.id)) problems.push(`the step id "${step.id}" is not a URL identifier`);
		if (seen.has(step.id)) problems.push(`the step id "${step.id}" is used twice`);
		seen.add(step.id);
	}
	return problems;
}

/** Why the steps do not own the submit schema's keys exactly once each. */
function ownershipProblems<V extends FieldValues, TOut>(definition: WizardDefinition<V, TOut>): string[] {
	const keys = submitSchemaKeys(definition.schema);
	if (keys === null) {
		return ["the submit schema's keys cannot be read: it must be an object schema, or a transform, union or intersection of them"];
	}
	const problems: string[] = [];
	const owned: { readonly step: string; readonly field: string }[] = [];
	for (const step of definition.steps) {
		for (const field of step.fields) owned.push({ step: step.id, field });
	}
	for (const key of keys) {
		if (!owned.some((entry) => topLevelKey(entry.field) === key)) {
			problems.push(`"${key}" is in the submit schema and owned by no step`);
		}
	}
	for (const entry of owned) {
		if (!keys.includes(topLevelKey(entry.field))) {
			problems.push(`step "${entry.step}" owns "${entry.field}", which the submit schema does not have`);
		}
	}
	for (const [index, first] of owned.entries()) {
		for (const second of owned.slice(index + 1)) {
			if (first.step !== second.step && overlaps(first.field, second.field)) {
				problems.push(
					`"${first.field}" is owned by step "${first.step}" and "${second.field}" by step "${second.step}"`,
				);
			}
		}
	}
	const draftKeys = definition.draft === null ? null : draftTopLevelKeys(definition.draft.schema);
	for (const key of draftKeys ?? []) {
		if (!keys.includes(key)) problems.push(`the draft keeps "${key}", which the submit schema does not have`);
	}
	return problems;
}

/** Throws one error naming every problem, or returns when there is none. */
function refuse(id: string, problems: readonly string[]): void {
	if (problems.length === 0) return;
	throw new Error(`wizard "${id}": ${problems.join("; ")}`);
}

/**
 * Declares a wizard. Throws, when the module loads, if the ids cannot go in a URL or if the draft
 * schema is not an allowlist — see the header for what that means. Returns the definition as given.
 */
export function defineWizard<V extends FieldValues, TOut>(
	definition: WizardDefinition<V, TOut>,
): WizardDefinition<V, TOut> {
	refuse(definition.id, [...idProblems(definition), ...draftProblems(definition)]);
	return definition;
}

/**
 * Throws unless the wizard is complete: usable ids, a safe draft, and every key of the submit
 * schema owned by exactly one step. Run by the definitions test over every `*.wizard.ts`.
 */
export function assertWizardComplete<V extends FieldValues, TOut>(
	definition: WizardDefinition<V, TOut>,
): void {
	refuse(definition.id, [
		...idProblems(definition),
		...draftProblems(definition),
		...ownershipProblems(definition),
	]);
}

/** A value with the properties every wizard definition has. */
interface DefinitionLike {
	readonly id: unknown;
	readonly presentation: unknown;
	readonly schema: unknown;
	readonly steps: unknown;
	readonly draft: unknown;
}

/** Whether `value` has a definition's five properties, whatever they hold. */
function hasDefinitionProperties(value: unknown): value is DefinitionLike {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		"presentation" in value &&
		"schema" in value &&
		"steps" in value &&
		"draft" in value
	);
}

/**
 * Whether `value` looks like a wizard definition: the test that walks `*.wizard.ts` uses this to
 * find the definitions among a module's exports.
 */
export function isWizardDefinition(value: unknown): value is WizardDefinition<FieldValues, unknown> {
	return (
		hasDefinitionProperties(value) &&
		typeof value.id === "string" &&
		(value.presentation === "page" || value.presentation === "overlay") &&
		value.schema instanceof z.ZodType &&
		Array.isArray(value.steps)
	);
}
