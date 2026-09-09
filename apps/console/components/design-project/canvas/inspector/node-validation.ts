// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W4 — inline, per-field validation for the inspector config forms. Each node kind is validated
// against the SAME Drizzle-derived zod item schema the whole-graph save uses (project-form.schema),
// so what the form accepts always conforms to what the DB will store. Draft→Save is unchanged; this
// only surfaces the errors per field as you edit instead of only as a blocked save later.

import type { ZodTypeAny } from "zod";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { knobsFor, TEMPLATE_KNOBS, type TemplateKnob } from "@/lib/cloud-providers/template-knobs";
import { toRecord } from "@/lib/coerce";
import { knobControl, knobFieldKey } from "./template-knobs-section";
import {
	bucketItemSchema,
	cacheItemSchema,
	clusterSchema,
	databaseItemSchema,
	dnsSchema,
	helmRegistryItemSchema,
	networkSchema,
	nosqlItemSchema,
	projectSchema,
	queueItemSchema,
	registryItemSchema,
	repositoriesSchema,
	secretItemSchema,
	serviceItemSchema,
	topicItemSchema,
} from "@/lib/validations/project-form.schema";
import type { NodeKind } from "../graph/types";

/** The per-node zod schema for a kind, or undefined for kinds with no first-class form (out-of-band
 * add-ons / charts / external / chart_workload are configured elsewhere). */
const SCHEMA_BY_KIND: Partial<Record<NodeKind, ZodTypeAny>> = {
	service: serviceItemSchema,
	database: databaseItemSchema,
	cache: cacheItemSchema,
	queue: queueItemSchema,
	topic: topicItemSchema,
	nosql: nosqlItemSchema,
	secret: secretItemSchema,
	bucket: bucketItemSchema,
	registry: registryItemSchema,
	helm_registry: helmRegistryItemSchema,
	project: projectSchema,
	network: networkSchema,
	cluster: clusterSchema,
	dns: dnsSchema,
	repositories: repositoriesSchema,
};

/**
 * The knobs a component could be shown for a kind, when the node's cloud is not known.
 *
 * The per-kind zod schemas type `provider_config` loosely — a knob is a declared template variable,
 * not a column, so there is no generated shape to check it against — and the ONE thing this file can
 * still say honestly is whether a stored value is the SHAPE the template declared. Doing that needs
 * the knob's type, which needs the cloud, and the renderer that owns the call
 * (`config-fields.tsx`) asks by kind alone.
 *
 * So when the cloud is not given, a knob's type is taken from every cloud that declares one by that
 * name for that kind, and used only when they all AGREE. Today all 114 shared names agree; the
 * disagreement branch exists because the day one of them stops agreeing, guessing would be a
 * fabricated verdict against a value the user typed correctly for their own cloud.
 */
function knobByName(
	kind: NodeKind,
	name: string,
	provider?: CloudProviderSlug | null,
): TemplateKnob | null {
	if (provider) return knobsFor(provider, kind).find((k) => k.name === name) ?? null;
	let agreed: TemplateKnob | null = null;
	for (const cloud of TEMPLATE_KNOBS.clouds) {
		const found = knobsFor(cloud, kind).find((k) => k.name === name);
		if (!found) continue;
		if (agreed && knobControl(agreed) !== knobControl(found)) return null;
		agreed = agreed ?? found;
	}
	return agreed;
}

/**
 * Per-knob checks over the generated Advanced section's values.
 *
 * Deliberately only TWO, and only where the template itself states the answer: a `number` knob whose
 * stored value is text, and a JSON-shaped knob whose stored value never parsed. Both are states the
 * card can produce on purpose — it keeps what was typed rather than discarding it, precisely so this
 * can name the problem — and neither invents a constraint the template does not declare. Bounds,
 * enums and allowed values are NOT checked: a template that does not state them has not made them
 * wrong, and OpenTofu is the authority on the rest.
 *
 * Keyed by `knobFieldKey`, the same namespaced key the field carries, so a knob error can never
 * collide with a column error on the same card.
 */
function validateTemplateKnobs(
	kind: NodeKind,
	config: Record<string, unknown>,
	provider?: CloudProviderSlug | null,
): Record<string, string> {
	const errors: Record<string, string> = {};
	for (const [name, value] of Object.entries(toRecord(config.provider_config))) {
		if (typeof value !== "string" || value.trim() === "") continue;
		const knob = knobByName(kind, name, provider);
		if (!knob) continue;
		const control = knobControl(knob);
		if (control === "number") {
			// A numeric-looking string is not an error — some other write path may have stored the
			// number as text, and rejecting a value that IS the number the template asked for would be
			// a fabricated verdict. Only text that is not a number at all is named.
			if (!/^-?\d+(\.\d+)?$/.test(value.trim())) {
				errors[knobFieldKey(knob)] = "Must be a number.";
			}
		} else if (control === "json") {
			try {
				JSON.parse(value);
			} catch {
				errors[knobFieldKey(knob)] = "Must be valid JSON.";
			}
		}
	}
	return errors;
}

/**
 * Validate one node's config against its kind's item schema and return a map of top-level field key
 * → the first error message for that field. Empty when the config is valid, the kind has no schema,
 * or the issue can't be attributed to a field. Never throws.
 *
 * `provider` is optional: without it the generated knob checks fall back to the cross-cloud
 * agreement rule in `knobByName`, so the existing caller keeps working unchanged and still gets
 * them.
 */
export function validateNodeConfig(
	kind: NodeKind,
	config: Record<string, unknown>,
	provider?: CloudProviderSlug | null,
): Record<string, string> {
	// The knob checks are independent of the kind having a first-class form schema — a chart or an
	// add-on has no item schema and can still carry provider_config — so they run either way.
	const errors: Record<string, string> = validateTemplateKnobs(kind, config, provider);
	const schema = SCHEMA_BY_KIND[kind];
	if (!schema) return errors;
	const res = schema.safeParse(config);
	if (res.success) return errors;
	for (const issue of res.error.issues) {
		const key = issue.path.length > 0 ? String(issue.path[0]) : "";
		// First error per field wins (the field renders one message).
		if (key && !(key in errors)) errors[key] = issue.message;
	}
	return errors;
}
