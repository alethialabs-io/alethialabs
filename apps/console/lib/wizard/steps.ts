// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The wizard engine's decisions, as plain functions: which steps are shown, which step a URL may
// land on, which field a validation issue belongs to, and what the server says about a step that
// cannot be repeated. No React and no router, so each rule is tested without mounting anything.

import type { StepperItem, StepState } from "@repo/ui/wizard";
import type { FieldPath, FieldValues } from "react-hook-form";
import type { FieldErrors } from "@/lib/actions/result";
import type { Settlement, WizardStep } from "@/lib/wizard/types";

/** What the user is told when the check on an irreversible step itself fails. */
export const SETTLE_FAILED_MESSAGE =
	"We could not confirm whether this step already went through. Do not repeat it. Reload the page to check again.";

/** A validation issue, as far as sorting it goes: zod's issues have this shape. */
export interface IssueLike {
	readonly path: readonly PropertyKey[];
	readonly message: string;
}

/** A message for one field of the form. */
export interface FieldMessage<V extends FieldValues> {
	readonly field: FieldPath<V>;
	readonly message: string;
}

/** A field message together with the step that owns the field. */
export interface LocatedMessage<V extends FieldValues> extends FieldMessage<V> {
	readonly stepId: string;
}

/** Issues split into those a field owns and those no field does. */
export interface SortedIssues<M> {
	readonly fields: readonly M[];
	readonly unowned: readonly string[];
}

/** What asking every irreversible step where it stands came to. */
export interface GateOutcome {
	/** The answer that decides what is shown: the first step not done, else the last one done. */
	readonly settlement: Settlement | null;
	/** The step the wizard may not go past, because it is not done. */
	readonly pinnedAt: string | null;
	/** The step the wizard may not go back before, because what precedes it is done. */
	readonly floorAt: string | null;
	/** An absolute path a done step says the flow continues at. */
	readonly leaveFor: string | null;
}

/** The steps whose `when` holds for `values`, in order. */
export function visibleSteps<V extends FieldValues>(
	steps: readonly WizardStep<V>[],
	values: V,
): WizardStep<V>[] {
	return steps.filter((step) => step.when === undefined || step.when(values));
}

/** An issue path as react-hook-form writes a field path. */
export function issuePath(path: readonly PropertyKey[]): string {
	return path.map(String).join(".");
}

/**
 * The field in `fields` that `path` names: the field itself or the closest listed parent of it.
 * `null` when no listed field owns the path.
 */
export function ownerField<V extends FieldValues>(
	fields: readonly FieldPath<V>[],
	path: string,
): FieldPath<V> | null {
	let owner: FieldPath<V> | null = null;
	let ownerLength = -1;
	for (const field of fields) {
		const text = `${field}`;
		if ((path === text || path.startsWith(`${text}.`)) && text.length > ownerLength) {
			owner = field;
			ownerLength = text.length;
		}
	}
	return owner;
}

/** A step's issues: one message per field it owns, and the messages no field of it owns. */
export function sortIssues<V extends FieldValues>(
	issues: readonly IssueLike[],
	fields: readonly FieldPath<V>[],
): SortedIssues<FieldMessage<V>> {
	const byField: FieldMessage<V>[] = [];
	const unowned: string[] = [];
	for (const issue of issues) {
		const field = ownerField(fields, issuePath(issue.path));
		if (field === null) unowned.push(issue.message);
		else if (!byField.some((entry) => `${entry.field}` === `${field}`)) {
			byField.push({ field, message: issue.message });
		}
	}
	return { fields: byField, unowned };
}

/** The issues of one step for `values`, or `null` when its schema passes. */
export function checkStep<V extends FieldValues>(
	step: WizardStep<V>,
	values: V,
): SortedIssues<FieldMessage<V>> | null {
	const result = step.schema.safeParse(values);
	return result.success ? null : sortIssues(result.error.issues, step.fields);
}

/** The step among `steps` that owns `path`, with the owning field; `null` when none does. */
function locatePath<V extends FieldValues>(
	steps: readonly WizardStep<V>[],
	path: string,
): { readonly stepId: string; readonly field: FieldPath<V> } | null {
	for (const step of steps) {
		const field = ownerField(step.fields, path);
		if (field !== null) return { stepId: step.id, field };
	}
	return null;
}

/** Issues of the whole form, each placed on the step that owns its field, in step order. */
export function locateIssues<V extends FieldValues>(
	steps: readonly WizardStep<V>[],
	issues: readonly IssueLike[],
): SortedIssues<LocatedMessage<V>> {
	const located: LocatedMessage<V>[] = [];
	const unowned: string[] = [];
	for (const issue of issues) {
		const owner = locatePath(steps, issuePath(issue.path));
		if (owner === null) unowned.push(issue.message);
		else located.push({ ...owner, message: issue.message });
	}
	return { fields: inStepOrder(steps, located), unowned };
}

/** A server's field errors, each placed on the step that owns its field, in step order. */
export function locateFieldErrors<V extends FieldValues>(
	steps: readonly WizardStep<V>[],
	errors: FieldErrors,
): SortedIssues<LocatedMessage<V>> {
	const located: LocatedMessage<V>[] = [];
	const unowned: string[] = [];
	for (const [name, messages] of Object.entries(errors)) {
		const message = messages?.[0];
		if (messages === undefined || message === undefined) continue;
		const owner = locatePath(steps, name);
		if (owner === null) unowned.push(...messages);
		else located.push({ ...owner, message });
	}
	return { fields: inStepOrder(steps, located), unowned };
}

/** `messages` ordered by the position of their step. */
function inStepOrder<V extends FieldValues>(
	steps: readonly WizardStep<V>[],
	messages: readonly LocatedMessage<V>[],
): LocatedMessage<V>[] {
	const position = (stepId: string) => steps.findIndex((step) => step.id === stepId);
	return [...messages].sort((a, b) => position(a.stepId) - position(b.stepId));
}

/** The position of step `id` among `steps`, or -1 when it is absent or `null`. */
export function stepIndex<V extends FieldValues>(
	steps: readonly WizardStep<V>[],
	id: string | null,
): number {
	return id === null ? -1 : steps.findIndex((step) => step.id === id);
}

/** What `resolveStepIndex` decides from. */
export interface StepRequest<V extends FieldValues> {
	/** The steps shown, in order. */
	readonly steps: readonly WizardStep<V>[];
	/** The step the URL (or a draft) asks for. */
	readonly requested: string | null;
	readonly values: V;
	readonly floorAt: string | null;
	readonly pinnedAt: string | null;
}

/**
 * The step that may be on screen for a request. An unknown or absent step is the first one. A
 * step is never before the floor nor past the pin, and never past a predecessor whose schema
 * does not pass — the request lands on that predecessor instead.
 */
export function resolveStepIndex<V extends FieldValues>(request: StepRequest<V>): number {
	const { steps, values } = request;
	const floor = Math.max(stepIndex(steps, request.floorAt), 0);
	const pinned = stepIndex(steps, request.pinnedAt);
	const ceiling = Math.max(pinned === -1 ? steps.length - 1 : pinned, floor);
	const wanted = Math.max(stepIndex(steps, request.requested), 0);
	const target = Math.min(Math.max(wanted, floor), ceiling);
	for (let index = floor; index < target; index += 1) {
		const step = steps[index];
		if (step !== undefined && checkStep(step, values) !== null) return index;
	}
	return target;
}

/** The rail's items: the current step, the ones with an error, the ones passed and the ones ahead. */
export function stepperItems<V extends FieldValues>(
	steps: readonly WizardStep<V>[],
	currentIndex: number,
	hasError: (step: WizardStep<V>) => boolean,
): StepperItem[] {
	return steps.map((step, index) => {
		const state: StepState =
			index === currentIndex
				? "current"
				: hasError(step)
					? "invalid"
					: index < currentIndex
						? "done"
						: "todo";
		return { id: step.id, label: step.label, state };
	});
}

/** Whether `path` is an absolute path on this site (and not a protocol-relative URL). */
function isLocalPath(path: string): boolean {
	return path.startsWith("/") && !path.startsWith("//");
}

/** One step's answer; a check that throws is "unknown", never "not-started". */
async function settleOne(settle: () => Promise<Settlement>): Promise<Settlement> {
	try {
		return await settle();
	} catch {
		return { kind: "unknown", message: SETTLE_FAILED_MESSAGE };
	}
}

/**
 * Asks each irreversible step among `steps`, in order, where it stands, and stops at the first
 * that is not done. A done step moves the floor to where it says the flow continues; one that
 * names a path outside the wizard ends the walk with `leaveFor`.
 */
export async function settleGates<V extends FieldValues>(
	steps: readonly WizardStep<V>[],
): Promise<GateOutcome> {
	let floorAt: string | null = null;
	let last: Settlement | null = null;
	for (const [index, step] of steps.entries()) {
		if (step.gate?.kind !== "irreversible") continue;
		const settlement = await settleOne(step.gate.settle);
		if (settlement.kind !== "done") {
			return { settlement, pinnedAt: step.id, floorAt, leaveFor: null };
		}
		last = settlement;
		if (stepIndex(steps, settlement.continueAt) !== -1) {
			floorAt = settlement.continueAt;
		} else if (isLocalPath(settlement.continueAt)) {
			return { settlement, pinnedAt: null, floorAt, leaveFor: settlement.continueAt };
		} else {
			floorAt = steps[index + 1]?.id ?? step.id;
		}
	}
	return { settlement: last, pinnedAt: null, floorAt, leaveFor: null };
}
