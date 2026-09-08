// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The card's generated "Advanced" section: every template variable a component can actually set,
// turned into a control that writes `provider_config[name]`.
//
// The manifest (`lib/cloud-providers/template-knobs.ts`) has already answered the only question
// that matters — which knobs are OFFERABLE — and `knobsFor` applies all three filters (`reachable`,
// `!ownedByProvider`, `!typed`). Nothing here re-asks any of them: a control this file renders is a
// control the manifest says lands on tofu, and a knob it excludes is one no user should be shown.
//
// What is left is the mapping from a tofu type to a control, and the one rule that makes the whole
// section honest: UNSETTING A KNOB DELETES THE KEY. A `provider_config` entry holding `null` or `""`
// is not "the template's default" — it is an override to null, which is a different apply. Every
// `set` below therefore removes the key when the control is emptied, and never writes an empty
// sentinel as a value.

import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { knobsFor, type TemplateKnob } from "@/lib/cloud-providers/template-knobs";
import { toRecord, toStr, toStrArray } from "@/lib/coerce";
import type { NodeKind } from "../graph/types";
import type { FieldDef, FieldOption } from "./config-schema";

/** A node config as the generic field engine sees it — an open bag of JSONB-backed columns. */
type AnyConfig = Record<string, unknown>;

/**
 * The tri-state "not set" option's value.
 *
 * A NON-EMPTY sentinel on purpose: `OptionSelect` falls back to `options[0].value` whenever the
 * current value is falsy, so an empty-string option and "nothing selected" would be the same state
 * to the control and it could never report the difference back.
 */
export const KNOB_UNSET = "__template_default__";

/**
 * Which control a knob gets. Named separately from the `FieldDef` it produces because
 * `node-validation.ts` asks the SAME question to decide what a value is allowed to be — a number
 * knob and a JSON knob are the only two whose stored value can be wrong in a way the card can name,
 * and both would drift the moment the two files answered "which control is this" differently.
 *
 *   text        — `string`.
 *   number      — `number`. Rendered as a `text` FieldDef; `knobField` states why at the case.
 *   bool        — `bool`, as a THREE-state select rather than a switch (see `boolOptions`).
 *   string-list — `list(string)` / `set(string)` only.
 *   json        — everything else: `map`, `object`, `any`, and every `list(object(…))`.
 */
export type KnobControl = "text" | "number" | "bool" | "string-list" | "json";

/**
 * A `list` knob is only a string-list control when its ELEMENTS are strings.
 *
 * `list` is the manifest's coarse type, and 14 of the 23 settable list knobs are `list(object({…}))`
 * — a row editor over `string[]` would read those as zero rows (`toStrArray` drops every non-string
 * member) and then commit the empty array over the user's stored value on the next edit. A silent
 * delete is worse than a raw JSON box, so only the genuinely string-shaped lists get the list
 * control.
 */
function isStringList(typeExpr: string): boolean {
	return /^\s*(list|set)\s*\(\s*string\s*\)\s*$/.test(typeExpr);
}

/** The control a knob's declared type maps onto. */
export function knobControl(knob: TemplateKnob): KnobControl {
	switch (knob.kind) {
		case "string":
			return "text";
		case "number":
			return "number";
		case "bool":
			return "bool";
		case "list":
			return isStringList(knob.typeExpr) ? "string-list" : "json";
		default:
			return "json";
	}
}

/**
 * The `FieldDef.key` for a knob.
 *
 * NAMESPACED, because the key is the inspector's error channel (`errors[field.key]`) and its React
 * key, and a knob's name is a tofu variable name chosen by a template author — `value`, `location`
 * and `keepers` are all real knob names, and each of them is also a plausible column key on some
 * kind. The prefix makes a collision with a hand-written field impossible rather than unlikely.
 *
 * It is never a config key: every knob field reads and writes through `get`/`set`.
 */
export function knobFieldKey(knob: TemplateKnob): string {
	return `knob:${knob.name}`;
}

/** The knob's current override, or `undefined` when the key is absent (the template default). */
function readKnob(knob: TemplateKnob, config: AnyConfig): unknown {
	return toRecord(config.provider_config)[knob.name];
}

/**
 * The patch that sets a knob — or, when `value` is `undefined`, the patch that DELETES it.
 *
 * One key (`provider_config`), rebuilt whole, because the field engine merges a `set` patch by key:
 * there is no "remove this nested entry" patch it could express, so removal has to be expressed as a
 * new object that lacks the entry.
 */
function writeKnob(
	knob: TemplateKnob,
	config: AnyConfig,
	value: unknown,
): Partial<AnyConfig> {
	const next = toRecord(config.provider_config);
	if (value === undefined) delete next[knob.name];
	else next[knob.name] = value;
	return { provider_config: next };
}

/** The knob's declared default rendered for a human, or null when the template declares none. */
function defaultText(knob: TemplateKnob): string | null {
	if (!("default" in knob) || knob.default === undefined) return null;
	if (typeof knob.default === "string") return knob.default;
	try {
		return JSON.stringify(knob.default) ?? null;
	} catch {
		return null;
	}
}

/**
 * The description under a knob's control: what the template says it does, then what it is set to
 * when you leave the control alone.
 *
 * The default is the whole point of showing it. Without it "empty" reads as "off", and the user
 * cannot tell what they are overriding — which is the difference between changing a value and
 * discovering, at apply, what the value used to be.
 */
function knobDescription(knob: TemplateKnob, control: KnobControl): string {
	const parts: string[] = [];
	if (knob.description.trim()) parts.push(knob.description.trim());
	const fallback = defaultText(knob);
	parts.push(
		fallback === null
			? "The template declares no literal default."
			: `Template default: ${fallback}.`,
	);
	if (control === "json") parts.push(`JSON, typed ${knob.typeExpr.replace(/\s+/g, " ")}.`);
	parts.push(
		control === "bool"
			? "Choose the template default to remove the override."
			: control === "string-list"
				? "Removing every row removes the override."
				: "Clearing the field removes the override.",
	);
	if (knob.sensitive) {
		parts.push("Sensitive — the stored value is never shown back; type a new one to replace it.");
	}
	return parts.join(" ");
}

/**
 * A `text`-shaped knob's stored value as display text.
 *
 * A sensitive knob renders EMPTY whatever is stored: the card is a design surface, not a secret
 * reader, and a value echoed into an `<input>` is a value in the DOM, the accessibility tree and
 * every screenshot of the page.
 */
function displayText(knob: TemplateKnob, raw: unknown): string {
	if (knob.sensitive) return "";
	if (raw === undefined || raw === null) return "";
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	try {
		return JSON.stringify(raw) ?? "";
	} catch {
		return "";
	}
}

/**
 * Committing a `text` control's value.
 *
 * `parse` turns the typed text into the value to store; returning `undefined` means "unset". A
 * sensitive knob treats an EMPTY box as no-op rather than as unset — its box is empty on every
 * render, so a stray focus-then-blur would otherwise delete a value the user was never shown.
 */
function textSetter(
	knob: TemplateKnob,
	parse: (text: string) => unknown,
): (value: unknown, config: AnyConfig) => Partial<AnyConfig> {
	return (value, config) => {
		const text = typeof value === "string" ? value : "";
		if (text.trim() === "") {
			if (knob.sensitive) return { provider_config: toRecord(config.provider_config) };
			return writeKnob(knob, config, undefined);
		}
		return writeKnob(knob, config, parse(text));
	};
}

/** A decimal integer or decimal fraction, and nothing else — not `0x10`, not `1e3`, not `Infinity`. */
const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * The three-state option list for a bool knob.
 *
 * WHY A BOOL KNOB IS A TRI-STATE SELECT AND NOT A SWITCH.
 *
 * A knob has three states — `true`, `false`, and ABSENT, which means "whatever the template
 * defaults to" — and a switch has two. The card's switch also renders `checked = raw !== false`, so
 * an absent knob whose template default is `false` would paint as ON: the control would state the
 * opposite of what will be applied.
 *
 * A select says all three out loud, names the default in the first option, and gives the way back to
 * it that the wave asked for. No extra "reset" affordance is needed, and none is invented: the third
 * option IS the reset.
 */
function boolOptions(knob: TemplateKnob): FieldOption[] {
	const fallback = defaultText(knob);
	return [
		{
			value: KNOB_UNSET,
			label: fallback === null ? "Template default" : `Template default (${fallback})`,
		},
		{ value: "true", label: "On" },
		{ value: "false", label: "Off" },
	];
}

/** One knob's control. Exported so a synthetic knob can be pinned without the real manifest. */
export function knobField(knob: TemplateKnob): FieldDef {
	const control = knobControl(knob);
	const key = knobFieldKey(knob);
	const label = knob.name;
	const description = knobDescription(knob, control);
	const fallback = defaultText(knob);

	switch (control) {
		case "bool":
			return {
				key,
				type: "select",
				label,
				description,
				options: boolOptions(knob),
				get: (config) => {
					const raw = readKnob(knob, config);
					return typeof raw === "boolean" ? String(raw) : KNOB_UNSET;
				},
				set: (value, config) => {
					const text = toStr(value);
					if (text === "true") return writeKnob(knob, config, true);
					if (text === "false") return writeKnob(knob, config, false);
					return writeKnob(knob, config, undefined);
				},
			};

		case "string-list":
			return {
				key,
				type: "list",
				label,
				description,
				item: { mono: true },
				get: (config) => toStrArray(readKnob(knob, config)),
				// Rows are NOT filtered here. `write` runs on every keystroke and on Add, which appends
				// a blank row — dropping blanks at this seam is exactly the defect that made Add useless
				// before the buffer landed, because the row was stripped by the same write that created
				// it. An all-empty list is the unset signal.
				set: (value, config) => {
					const rows = toStrArray(value);
					return writeKnob(knob, config, rows.length === 0 ? undefined : rows);
				},
			};

		// WHY A NUMBER KNOB IS A `text` FIELD AND NOT A `number` ONE.
		//
		// The card's `number` control commits through `FieldBuffer.flushNumber`, which reads
		// `form.getValues()[field.key]` and commits `{[field.key]: n}` — it addresses the config by
		// KEY and never consults `field.get` / `field.set`. Every knob field writes a NESTED
		// `provider_config` entry through `set`, so on a `number` field that path reads `undefined`
		// on every blur, concludes the box is empty and (with `optional: true`) commits
		// `{"<knob>": null}`: a stray top-level key, with the typed number never reaching
		// `provider_config` at all.
		//
		// `text` commits through `flush`, which DOES take its keys from `field.set`, so it is the
		// only control in the current engine that can carry a nested write. The numeric intent is
		// kept where this file can honour it — the text is parsed here and a decimal is stored as a
		// real `number`. Teaching `flushNumber` to respect `get`/`set` belongs to `config-fields.tsx`,
		// which is another lane's file (#4256) and outside this issue's scope.
		case "number":
			return {
				key,
				type: "text",
				label,
				mono: true,
				description,
				placeholder: fallback ?? knob.typeExpr,
				get: (config) => displayText(knob, readKnob(knob, config)),
				set: textSetter(knob, (text) => {
					const trimmed = text.trim();
					// Not a number? Keep the text. `node-validation` names it; discarding it here would
					// leave the user staring at a box that empties itself for no stated reason.
					return DECIMAL.test(trimmed) ? Number.parseFloat(trimmed) : text;
				}),
			};

		case "json":
			return {
				key,
				type: "text",
				label,
				mono: true,
				description,
				placeholder: fallback ?? knob.typeExpr.replace(/\s+/g, " "),
				get: (config) => displayText(knob, readKnob(knob, config)),
				// Unparseable text is stored AS TEXT rather than dropped, for the same reason a number
				// knob keeps its text: `node-validation` can then say "must be valid JSON" against the
				// thing the user actually typed.
				set: textSetter(knob, (text) => {
					try {
						return JSON.parse(text);
					} catch {
						return text;
					}
				}),
			};

		default:
			return {
				key,
				type: "text",
				label,
				mono: true,
				description,
				placeholder: knob.sensitive ? undefined : (fallback ?? undefined),
				get: (config) => displayText(knob, readKnob(knob, config)),
				set: textSetter(knob, (text) => text),
			};
	}
}

/**
 * Every knob one component can set on one cloud, as inspector fields.
 *
 * The manifest decides membership; this decides presentation. An ITEM-shaped component (a bucket, a
 * queue, a secret) is modelled in the template as one entry of a `map(object)` / `list(object)`
 * variable, and its settable knobs are that object's ATTRIBUTES — they carry `itemScope` and are
 * merged into the item by `mergeItemProviderConfig`. Nothing special happens here: the write is
 * still `provider_config[name]` on that node, and the ROOT variable is excluded by the manifest
 * itself (it is `reachable: false`), so this file never has to know which shape it is looking at.
 */
export function templateKnobFields(
	provider: CloudProviderSlug,
	kind: NodeKind,
): FieldDef[] {
	return knobsFor(provider, kind).map(knobField);
}
