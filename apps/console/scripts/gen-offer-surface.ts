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
	visibleWhen?: (config: unknown, ctx: unknown) => boolean;
	unavailableWhen?: (config: unknown, ctx: unknown) => string | null;
}

interface KindSpec {
	sections?: Array<{ fields?: FieldSpec[] }>;
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

const fieldsOf = (kind: string): FieldSpec[] => {
	const spec = CONFIG_SCHEMA[kind as keyof typeof CONFIG_SCHEMA] as KindSpec | undefined;
	return (spec?.sections ?? []).flatMap((s) => s.fields ?? []);
};

const kindUnsupported = (kind: string, provider: Provider): boolean => {
	const list = (UNSUPPORTED_KINDS_BY_PROVIDER as Record<string, readonly string[] | undefined>)[provider];
	return Array.isArray(list) && list.includes(kind);
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
	const entry = (NODE_REGISTRY as Record<string, { defaultData?: (p: string) => unknown } | undefined>)[kind];
	let base: Record<string, unknown> = {};
	try {
		base = (entry?.defaultData?.(provider) as Record<string, unknown>) ?? {};
	} catch {
		base = {};
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
	if (typeof field.visibleWhen === "function") {
		try {
			visible = field.visibleWhen(config, ctx) === true;
		} catch {
			visible = false;
		}
	}
	if (!visible) return { visible: false };

	let unavailable: string | undefined;
	if (typeof field.unavailableWhen === "function") {
		try {
			unavailable = field.unavailableWhen(config, ctx) ?? undefined;
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
			gated: typeof field.visibleWhen === "function",
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
