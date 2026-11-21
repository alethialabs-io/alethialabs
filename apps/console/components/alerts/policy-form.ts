// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ONE form shape of an alert policy, shared by the create sheet (policy-sheet.tsx) and the
// inline editor (policies-panel.tsx). Both are react-hook-form over `policyFormSchema`, so a rule
// about a policy — a name is required, at least one event, at least one channel — is stated once
// and reads the same in both places: inline, under the field it is about. The editor used to be
// raw `useState` that toasted its validation and saved an emptied name as "Untitled policy".

import type { Path } from "react-hook-form";
import { z } from "zod";
import type { PolicyDTO } from "@/app/server/actions/alerts";
import { isSeverity } from "@/components/alerts/policy-shared";
import type { PolicyInput } from "@/lib/validations/alerts";

/** Validation for an alert policy form, create or edit. */
export const policyFormSchema = z.object({
	name: z.string().trim().min(1, "Name your policy").max(120),
	description: z.string().max(500),
	enabled: z.boolean(),
	event_patterns: z.array(z.string()).min(1, "Pick at least one event."),
	channels: z
		.array(z.object({ id: z.string(), min_severity: z.string().optional() }))
		.min(1, "Bind at least one channel."),
	min_severity: z.string(),
	project_ids: z.array(z.string()),
	job_types: z.array(z.string()),
	resource_types: z.array(z.string()),
	actions: z.array(z.string()),
	throttle_seconds: z.number(),
});

/** The values of an alert policy form. */
export type PolicyFormValues = z.infer<typeof policyFormSchema>;

/** A new policy's starting values. */
export const NEW_POLICY_FORM: PolicyFormValues = {
	name: "",
	description: "",
	enabled: true,
	event_patterns: [],
	channels: [],
	min_severity: "any",
	project_ids: [],
	job_types: [],
	resource_types: [],
	actions: [],
	throttle_seconds: 300,
};

/** Marks a programmatic write as an edit, and re-validates the field it wrote. */
export const POLICY_EDIT = { shouldDirty: true, shouldValidate: true } as const;

/**
 * The form fields a server validation key can name directly. A key outside this list (a
 * `match.*` condition) lands in the form's root error, so it is still shown.
 */
export const POLICY_SERVER_FIELDS = [
	"name",
	"description",
	"event_patterns",
	"channels",
	"throttle_seconds",
] as const satisfies readonly Path<PolicyFormValues>[];

/**
 * The event list with `key` toggled, sorted. Sorted so the list is a SET as far as the form's
 * dirty check is concerned: toggling an event off and on again is not an edit.
 */
export function toggleEventIn(list: readonly string[], key: string): string[] {
	const next = list.includes(key) ? list.filter((x) => x !== key) : [...list, key];
	return next.sort();
}

/**
 * Channel bindings in the form's one shape: a binding with no severity floor carries no
 * `min_severity` key at all. The routing picker writes `{ min_severity: undefined }` when a floor
 * is set back to "any", and the dirty check compares keys, so without this an undone change would
 * still read as an edit.
 */
export function normalizeBindings(
	bindings: readonly { id: string; min_severity?: string }[],
): PolicyFormValues["channels"] {
	return bindings.map((b) =>
		b.min_severity ? { id: b.id, min_severity: b.min_severity } : { id: b.id },
	);
}

/** The form values of an existing policy — what its edit form starts from and is dirty against. */
export function policyFormFrom(p: PolicyDTO): PolicyFormValues {
	return {
		name: p.name,
		description: p.description ?? "",
		enabled: p.enabled,
		event_patterns: [...p.event_patterns].sort(),
		channels: normalizeBindings(
			p.channels.map((c) => ({ id: c.id, min_severity: c.minSeverity ?? undefined })),
		),
		min_severity: p.match.min_severity ?? "any",
		project_ids: p.match.project_ids ?? [],
		job_types: p.match.job_types ?? [],
		resource_types: p.match.resource_types ?? [],
		actions: p.match.actions ?? [],
		throttle_seconds: p.throttle_seconds,
	};
}

/** The server action's input for validated form values. */
export function toPolicyInput(values: PolicyFormValues): PolicyInput {
	return {
		name: values.name.trim(),
		description: values.description.trim() || undefined,
		event_patterns: values.event_patterns,
		channels: values.channels.map((b) => ({
			id: b.id,
			min_severity:
				b.min_severity && isSeverity(b.min_severity) ? b.min_severity : undefined,
		})),
		match: {
			...(isSeverity(values.min_severity) ? { min_severity: values.min_severity } : {}),
			...(values.project_ids.length ? { project_ids: values.project_ids } : {}),
			...(values.job_types.length ? { job_types: values.job_types } : {}),
			...(values.resource_types.length ? { resource_types: values.resource_types } : {}),
			...(values.actions.length ? { actions: values.actions } : {}),
		},
		severity: "warning",
		throttle_seconds: values.throttle_seconds,
		escalate: false,
		recipient: undefined,
		enabled: values.enabled,
	};
}
