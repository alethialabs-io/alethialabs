// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Derive the OFFER SURFACE — what the canvas actually offers, per cloud — by evaluating the
// inspector schema rather than pattern-matching its source.
//
// The offer-parity guard needs to know which switches a user can see on which cloud. Those are
// decided by `visibleWhen` closures over (config, {provider, caps}), and the ones that matter read
// the catalog. No regex reads a closure, which is why the guard currently skips every gated field
// and measures 12 option cells out of a far larger surface — and why "add a visibleWhen" silently
// removes an offer from the matrix instead of failing the build.
//
// So: import the schema, call the predicates, and check the answer in. CI regenerates and diffs,
// exactly like `gen:keyless-cells`.

import { writeFileSync } from "node:fs";
import {
	CONFIG_SCHEMA,
	NO_CAPABILITIES,
} from "@/components/design-project/canvas/inspector/config-schema";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import { UNSUPPORTED_KINDS_BY_PROVIDER } from "@/lib/cloud-providers/unsupported-kinds";

const PROVIDERS = ["aws", "gcp", "azure", "alibaba", "hetzner"] as const;
type Provider = (typeof PROVIDERS)[number];

/** Field types whose value is an OFFER — something a user picks that a cloud must honor. */
const MEASURED_TYPES = new Set(["switch"]);

interface FieldSpec {
	key: string;
	type: string;
	label?: string;
	// Held as `unknown` and called through callPredicate. `typeof x === "function"` narrows to
	// `Function`, which is not assignable to a specific signature — and the only ways to bridge that
	// are a cast (forbidden) or asserting a shape we have not checked. The return value is validated
	// at the call site instead, which is where it actually matters.
	visibleWhen?: unknown;
	unavailableWhen?: unknown;
}

interface OfferCell {
	visible: boolean;
	/** Product-voice reason when the field is shown but disabled (`unavailableWhen`). */
	unavailable?: string;
}

interface Offer {
	kind: string;
	key: string;
	type: string;
	label?: string;
	gated: boolean;
	offeredOn: Provider[];
	unavailableOn: Record<string, string>;
	notOfferedOn: Provider[];
}

/**
 * Read a property off an unknown value, or undefined.
 *
 * The schema is walked structurally rather than through its declared types: this reads across
 * fifteen kinds whose field unions differ, and the shapes that matter here (`sections`, `fields`,
 * `visibleWhen`) are common to all of them. Narrowing at runtime keeps that honest without a cast —
 * an `as` would assert a shape rather than check one, and a schema change would then surface as a
 * silent undefined instead of a loud failure.
 */
function prop(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return Reflect.get(value, key);
}

/** Call an unknown value as a predicate, or undefined when it is not callable. */
function callPredicate(fn: unknown, config: unknown, ctx: unknown): unknown {
	if (typeof fn !== "function") return undefined;
	return Reflect.apply(fn, undefined, [config, ctx]);
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asFieldSpec(value: unknown): FieldSpec | null {
	const key = prop(value, "key");
	const type = prop(value, "type");
	if (typeof key !== "string" || typeof type !== "string") return null;
	const label = prop(value, "label");
	const visibleWhen = prop(value, "visibleWhen");
	const unavailableWhen = prop(value, "unavailableWhen");
	return {
		key,
		type,
		label: typeof label === "string" ? label : undefined,
		visibleWhen: typeof visibleWhen === "function" ? visibleWhen : undefined,
		unavailableWhen: typeof unavailableWhen === "function" ? unavailableWhen : undefined,
	};
}

const fieldsOf = (kind: string): FieldSpec[] =>
	asArray(prop(CONFIG_SCHEMA, kind) === undefined ? undefined : prop(prop(CONFIG_SCHEMA, kind), "sections"))
		.flatMap((section) => asArray(prop(section, "fields")))
		.map(asFieldSpec)
		.filter((f): f is FieldSpec => f !== null);

const kindUnsupported = (kind: string, provider: Provider): boolean => {
	const list = prop(UNSUPPORTED_KINDS_BY_PROVIDER, provider);
	return asArray(list).includes(kind);
};

/**
 * Configs to evaluate a gate against.
 *
 * A gate resolving false under EVERY witness on EVERY cloud is not a cloud boundary — it is a
 * config-shape boundary this generator failed to satisfy, and reporting it as "not offered
 * anywhere" would silently delete a real offer from the matrix. Two witnesses: the kind's own
 * defaults, and the same with every switch turned on (which is what unlocks gates of the form
 * `c.generate !== false` or `c.foo_enabled`).
 */
function witnessesFor(kind: string, provider: Provider): unknown[] {
	const defaultData = prop(prop(NODE_REGISTRY, kind), "defaultData");
	let base: Record<string, unknown> = {};
	if (defaultData !== undefined) {
		try {
			const produced = callPredicate(defaultData, provider, undefined);
			if (typeof produced === "object" && produced !== null) {
				base = { ...produced };
			}
		} catch {
			base = {};
		}
	}
	const allOn: Record<string, unknown> = { ...base };
	for (const f of fieldsOf(kind)) {
		if (f.type === "switch") allOn[f.key] = true;
	}
	return [base, allOn];
}

/** Evaluate one gate; a throw means "this witness did not satisfy it", never "offered". */
function evaluate(field: FieldSpec, config: unknown, provider: Provider): OfferCell {
	const ctx = { provider, config, caps: NO_CAPABILITIES };
	let visible = true;
	if (field.visibleWhen !== undefined) {
		try {
			visible = callPredicate(field.visibleWhen, config, ctx) === true;
		} catch {
			visible = false;
		}
	}
	if (!visible) return { visible: false };

	let unavailable: string | undefined;
	if (field.unavailableWhen !== undefined) {
		try {
			const reason = callPredicate(field.unavailableWhen, config, ctx);
			unavailable = typeof reason === "string" && reason !== "" ? reason : undefined;
		} catch {
			unavailable = undefined;
		}
	}
	return { visible: true, unavailable };
}

const offers: Offer[] = [];
const unreachable: string[] = [];

for (const kind of Object.keys(CONFIG_SCHEMA)) {
	for (const field of fieldsOf(kind)) {
		if (!MEASURED_TYPES.has(field.type)) continue;

		const offeredOn: Provider[] = [];
		const notOfferedOn: Provider[] = [];
		const unavailableOn: Record<string, string> = {};

		for (const provider of PROVIDERS) {
			if (kindUnsupported(kind, provider)) {
				notOfferedOn.push(provider);
				continue;
			}
			const cells = witnessesFor(kind, provider).map((w) => evaluate(field, w, provider));
			const shown = cells.find((c) => c.visible);
			if (!shown) {
				notOfferedOn.push(provider);
				continue;
			}
			offeredOn.push(provider);
			if (shown.unavailable) unavailableOn[provider] = shown.unavailable;
		}

		// The anti-silence rule. A field no witness can surface on any cloud is this generator's
		// blind spot, not an absent offer — fail rather than record a false zero.
		if (offeredOn.length === 0) unreachable.push(`${kind}:${field.key}`);

		offers.push({
			kind,
			key: field.key,
			type: field.type,
			label: field.label,
			gated: field.visibleWhen !== undefined,
			offeredOn,
			unavailableOn,
			notOfferedOn,
		});
	}
}

offers.sort((a, b) => (a.kind + a.key).localeCompare(b.kind + b.key));

if (unreachable.length > 0) {
	console.error(
		"✗ offer surface — no witness config makes these visible on ANY cloud, so their gates cannot\n" +
			"  be measured. That is a blind spot in this generator, not an absent offer; extend\n" +
			"  witnessesFor() until each is reachable rather than letting the matrix record a zero:\n" +
			unreachable.map((u) => `    • ${u}`).join("\n"),
	);
	process.exit(1);
}

const out = { generated_from: "config-schema.ts", providers: PROVIDERS, offers };
const target = process.argv[2];
if (target) {
	writeFileSync(target, `${JSON.stringify(out, null, "\t")}\n`);
	console.log(`✓ offer surface — ${offers.length} offer(s) across ${PROVIDERS.length} clouds → ${target}`);
} else {
	console.log(JSON.stringify(out, null, "\t"));
}
