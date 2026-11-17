"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The wizard engine: one react-hook-form, a step held in the URL, a draft held in the tab.
//
// What the hook guarantees, and where each guarantee is decided:
//   - VALIDATION. `next()` parses the form with the current step's schema and puts each issue on
//     the field of that step its path names; an issue naming none becomes `formError`.
//     `submit()` does that for every step shown, then for the submit schema (steps.ts).
//   - NO SILENT SUBMIT. A failed `submit()` or `applyFieldErrors()` always ends in one of two
//     visible things: the first step owning a failing field, with that field focused, or
//     `formError`. There is no third outcome — a failure with nothing to point at gets a message.
//   - URL. The step on screen is derived from the URL on every render. A step the URL may not
//     show (unknown, past an unfinished predecessor, past a step the server has not settled) is
//     corrected with `replace`, never with a new history entry.
//   - DRAFT. Values are written after a pause in typing, through the draft schema and nothing
//     else (draft.ts). `complete()` and `discard()` remove the draft.
//   - IRREVERSIBLE STEPS. Before the first step is shown, and again on `next()` from such a step,
//     the engine asks the server where the step stands. Only that answer moves the wizard past
//     it; the URL cannot. While the answer is "in flight" or "unknown", nothing that could repeat
//     the step runs, and leaving the page while it is in flight asks first.
//
// `useWizardEngine` takes its surroundings as an argument, so it is tested with a location and a
// viewer made in the test. `useWizard` is the same hook wired to the console page.

import { useEffect, useRef, useState } from "react";
import { type FieldPath, type FieldValues, get, useForm, useWatch } from "react-hook-form";
import type { FieldErrors } from "@/lib/actions/result";
import {
	isWizardOpenInUrl,
	wizardClearPatch,
	wizardStepFromUrl,
	wizardStepPatch,
} from "@/lib/query/view-url-params";
import { clearDraft, mergeDraftInto, readDraft, writeDraft } from "@/lib/wizard/draft";
import { useWizardEnvironment } from "@/lib/wizard/location";
import {
	checkStep,
	type GateOutcome,
	type LocatedMessage,
	locateFieldErrors,
	locateIssues,
	resolveStepIndex,
	settleGates,
	stepIndex,
	stepperItems,
	visibleSteps,
} from "@/lib/wizard/steps";
import type {
	Settlement,
	UseWizardOptions,
	Wizard,
	WizardDefinition,
	WizardEnvironment,
	WizardStep,
} from "@/lib/wizard/types";

/** How long typing must pause before the draft is written. */
export const DRAFT_WRITE_DELAY_MS = 400;

/** What a failure with no field and no message of its own says. */
export const UNPLACED_FAILURE_MESSAGE = "That did not go through. Check your answers and try again.";

/** What the engine remembers between renders, besides the form. */
interface EngineState {
	readonly ready: boolean;
	readonly restored: boolean;
	/** The step a restored draft was on; used when the URL names none. */
	readonly draftStep: string | null;
	readonly settlement: Settlement | null;
	readonly pinnedAt: string | null;
	readonly floorAt: string | null;
	readonly formError: string | null;
	/** Moves each time a field is to be focused, so the focus effect runs for the same step too. */
	readonly focusTick: number;
}

const INITIAL_STATE: EngineState = {
	ready: false,
	restored: false,
	draftStep: null,
	settlement: null,
	pinnedAt: null,
	floorAt: null,
	formError: null,
	focusTick: 0,
};

/** The step at `index`, or the first one; throws for a wizard that shows no step at all. */
function stepAt<V extends FieldValues>(
	steps: readonly WizardStep<V>[],
	index: number,
	wizardId: string,
): WizardStep<V> {
	const step = steps[index] ?? steps[0];
	if (step === undefined) throw new Error(`wizard "${wizardId}" shows no step for these values`);
	return step;
}

/** The names of every query param the wizard's external steps own. */
function returnParams<V extends FieldValues>(steps: readonly WizardStep<V>[]): string[] {
	return steps.flatMap((step) => (step.gate?.kind === "external" ? step.gate.returnParams : []));
}

/** Whether nothing that could repeat an irreversible step may run. */
function isHeld(settlement: Settlement | null): boolean {
	return settlement?.kind === "in-flight" || settlement?.kind === "unknown";
}

/**
 * Runs a wizard against an environment given by the caller. See the header for what it guarantees.
 */
export function useWizardEngine<V extends FieldValues, TOut>(
	definition: WizardDefinition<V, TOut>,
	options: UseWizardOptions<V, TOut>,
	env: WizardEnvironment,
): Wizard<V, TOut> {
	const form = useForm<V, unknown, TOut>({ defaultValues: options.defaultValues });
	// Re-renders on every value change: the steps shown, the clamp and the rail all read values.
	useWatch({ control: form.control });
	const values = form.getValues();
	const { errors } = form.formState;
	const [state, setState] = useState<EngineState>(INITIAL_STATE);
	const pendingFocus = useRef<{ stepId: string; field: FieldPath<V> } | null>(null);
	const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastStep = useRef<string | null>(null);
	const completed = useRef(false);

	const shape = { id: definition.id, presentation: definition.presentation };
	const reader = { get: (name: string) => env.location.read(name) };
	const open = definition.presentation === "page" || isWizardOpenInUrl(reader, definition.id);
	const urlStep = wizardStepFromUrl(reader, shape);
	const steps = visibleSteps(definition.steps, values);
	const index = resolveStepIndex({
		steps,
		requested: urlStep ?? state.draftStep,
		values,
		floorAt: state.floorAt,
		pinnedAt: state.pinnedAt,
	});
	const current = stepAt(steps, index, definition.id);
	const shownStep = urlStep ?? steps[0]?.id ?? null;

	const draft = definition.draft;
	const viewerId = env.viewerId;
	const address =
		draft !== null && typeof viewerId === "string"
			? { id: definition.id, viewerId, scope: options.scope }
			: null;
	const waitingForViewer = draft !== null && viewerId === undefined;
	const now = env.now ?? Date.now;
	const held = isHeld(state.settlement);
	const inFlight = state.settlement?.kind === "in-flight";

	/** Records what the server said about the irreversible steps. */
	function applyOutcome(outcome: GateOutcome): void {
		setState((previous) => ({
			...previous,
			settlement: outcome.settlement,
			pinnedAt: outcome.pinnedAt,
			floorAt: outcome.floorAt,
		}));
	}

	/** A user's move to step `id`: a history entry, and the step a reopened overlay resumes at. */
	function pushStep(id: string): void {
		setState((previous) => ({ ...previous, draftStep: id, formError: null }));
		env.location.push(wizardStepPatch(shape, id));
	}

	/** Writes the draft now, unless the wizard has completed or keeps none. */
	function writeDraftNow(step: string): void {
		if (completed.current || draft === null || address === null) return;
		writeDraft(address, draft, form.getValues(), step, now());
	}

	/** Drops a scheduled draft write. Returns whether one was scheduled. */
	function cancelScheduledWrite(): boolean {
		if (writeTimer.current === null) return false;
		clearTimeout(writeTimer.current);
		writeTimer.current = null;
		return true;
	}

	/**
	 * Ends a failed validation visibly: errors on their fields, then the first failing step with
	 * its field focused, or `formError` when no field owns the failure.
	 */
	function showFailure(located: readonly LocatedMessage<V>[], unowned: readonly string[]): void {
		for (const entry of located) {
			form.setError(entry.field, { type: "validate", message: entry.message });
		}
		const first = located[0];
		const message =
			unowned.length > 0 ? unowned.join(" ") : first === undefined ? UNPLACED_FAILURE_MESSAGE : null;
		if (first !== undefined) pendingFocus.current = { stepId: first.stepId, field: first.field };
		setState((previous) => ({
			...previous,
			formError: message,
			focusTick: previous.focusTick + 1,
		}));
		if (first !== undefined && first.stepId !== current.id) {
			setState((previous) => ({ ...previous, draftStep: first.stepId }));
			env.location.push(wizardStepPatch(shape, first.stepId));
		}
	}

	// Boot: restore the draft, then ask every irreversible step where it stands. The step is not
	// shown before both have happened (`ready`).
	useEffect(() => {
		if (waitingForViewer) return undefined;
		let cancelled = false;
		const stored = draft !== null && address !== null ? readDraft(address, draft, now()) : null;
		if (stored !== null) {
			const base = form.getValues();
			form.reset({ ...base, ...mergeDraftInto(base, stored.values) });
		}
		void settleGates(visibleSteps(definition.steps, form.getValues())).then((outcome) => {
			if (cancelled) return;
			setState((previous) => ({
				...previous,
				ready: outcome.leaveFor === null,
				restored: stored !== null,
				draftStep: stored === null ? null : stored.step,
				settlement: outcome.settlement,
				pinnedAt: outcome.pinnedAt,
				floorAt: outcome.floorAt,
			}));
			if (outcome.leaveFor !== null) env.location.leave(outcome.leaveFor);
		});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- boots once per wizard, viewer and scope
	}, [definition.id, options.scope, viewerId, waitingForViewer]);

	// The URL follows the step the engine settled on, without a history entry.
	useEffect(() => {
		if (!state.ready || !open) return;
		if (shownStep !== current.id) env.location.replace(wizardStepPatch(shape, current.id));
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the step, not on the location object
	}, [state.ready, open, shownStep, current.id]);

	// A changed field loses its error at once and schedules a draft write; a step change writes now.
	useEffect(() => {
		if (!state.ready || !open) return undefined;
		const stepId = current.id;
		if (lastStep.current !== null && lastStep.current !== stepId) writeDraftNow(stepId);
		lastStep.current = stepId;
		const unsubscribe = form.subscribe({
			formState: { values: true },
			callback: ({ name }) => {
				if (name === undefined) return;
				for (const step of definition.steps) {
					const field = ownerFieldOf(step, name);
					if (field !== null) form.clearErrors(field);
				}
				cancelScheduledWrite();
				writeTimer.current = setTimeout(() => {
					writeTimer.current = null;
					writeDraftNow(stepId);
				}, DRAFT_WRITE_DELAY_MS);
			},
		});
		return () => {
			unsubscribe();
			if (cancelScheduledWrite()) writeDraftNow(stepId);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- re-subscribes per step and per draft address
	}, [state.ready, open, current.id, definition.id, options.scope, viewerId]);

	// Focus the field a failure pointed at, once its step is the one on screen.
	useEffect(() => {
		const target = pendingFocus.current;
		if (target === null || target.stepId !== current.id) return;
		pendingFocus.current = null;
		form.setFocus(target.field);
	}, [current.id, state.focusTick, form]);

	// Leaving while an irreversible step is in flight asks first.
	useEffect(() => {
		if (!inFlight) return undefined;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [inFlight]);

	/** Validates the current step and moves to the next one shown; from an irreversible step, asks the server first. */
	async function next(): Promise<void> {
		if (!state.ready) return;
		const shown = visibleSteps(definition.steps, form.getValues());
		const at = stepIndex(shown, current.id);
		const following = shown[at + 1];
		if (current.gate?.kind === "irreversible") {
			const outcome = await settleGates(shown);
			applyOutcome(outcome);
			if (outcome.leaveFor !== null) {
				env.location.leave(outcome.leaveFor);
				return;
			}
			if (outcome.pinnedAt === current.id) {
				if (outcome.settlement?.kind !== "not-started") return;
				const issues = checkStep(current, form.getValues());
				if (issues !== null) {
					showFailure(
						issues.fields.map((entry) => ({ ...entry, stepId: current.id })),
						issues.unowned,
					);
				}
				return;
			}
			const target = stepIndex(shown, outcome.floorAt) > at ? outcome.floorAt : (following?.id ?? null);
			if (target !== null) pushStep(target);
			return;
		}
		if (held) return;
		form.clearErrors(current.fields);
		const issues = checkStep(current, form.getValues());
		if (issues !== null) {
			showFailure(
				issues.fields.map((entry) => ({ ...entry, stepId: current.id })),
				issues.unowned,
			);
			return;
		}
		setState((previous) => ({ ...previous, formError: null }));
		if (following !== undefined) pushStep(following.id);
	}

	/** Goes one step back, never before a step the server says is done. */
	function back(): void {
		if (!state.ready || inFlight) return;
		const previousStep = steps[index - 1];
		if (previousStep === undefined || index - 1 < Math.max(stepIndex(steps, state.floorAt), 0)) return;
		pushStep(previousStep.id);
	}

	/** Goes to step `id` when the engine would show it for that request; otherwise does nothing. */
	function goTo(id: string): void {
		if (!state.ready || inFlight) return;
		const target = stepIndex(steps, id);
		if (target === -1 || target === index) return;
		const allowed = resolveStepIndex({
			steps,
			requested: id,
			values: form.getValues(),
			floorAt: state.floorAt,
			pinnedAt: state.pinnedAt,
		});
		if (allowed !== target) return;
		pushStep(id);
	}

	/** Validates every step shown, then the submit schema, and hands the parsed values to `onSubmit`. */
	function submit(): Promise<void> {
		if (!state.ready || held) return Promise.resolve();
		form.clearErrors();
		const fresh = form.getValues();
		const shown = visibleSteps(definition.steps, fresh);
		const located: LocatedMessage<V>[] = [];
		const unowned: string[] = [];
		for (const step of shown) {
			const issues = checkStep(step, fresh);
			if (issues === null) continue;
			located.push(...issues.fields.map((entry) => ({ ...entry, stepId: step.id })));
			unowned.push(...issues.unowned);
		}
		if (located.length === 0 && unowned.length === 0) {
			const parsed = definition.schema.safeParse(fresh);
			if (parsed.success) {
				setState((previous) => ({ ...previous, formError: null }));
				options.onSubmit(parsed.data);
				return Promise.resolve();
			}
			const sorted = locateIssues(shown, parsed.error.issues);
			located.push(...sorted.fields);
			unowned.push(...sorted.unowned);
		}
		showFailure(located, unowned);
		return Promise.resolve();
	}

	/** Places a server's field errors on their steps. */
	function applyFieldErrors(fields: FieldErrors): void {
		const sorted = locateFieldErrors(visibleSteps(definition.steps, form.getValues()), fields);
		showFailure(sorted.fields, sorted.unowned);
	}

	/** Ends the wizard after a successful submit: no draft, no params of its own left in the URL. */
	function complete(): void {
		completed.current = true;
		cancelScheduledWrite();
		if (address !== null) clearDraft(address);
		env.location.replace(wizardClearPatch(shape, returnParams(definition.steps)));
	}

	/** Starts over: default values, no draft, the first step. An overlay stays open. */
	function discard(): void {
		cancelScheduledWrite();
		if (address !== null) clearDraft(address);
		form.reset(options.defaultValues);
		lastStep.current = null;
		setState((previous) => ({ ...previous, restored: false, draftStep: null, formError: null }));
		const patch: Record<string, string | null> = { ...wizardStepPatch(shape, null) };
		for (const name of returnParams(definition.steps)) patch[name] = null;
		env.location.replace(patch);
	}

	return {
		form,
		items: stepperItems(steps, index, (step) =>
			step.fields.some((field) => get(errors, `${field}`) !== undefined),
		),
		current,
		isLast: index === steps.length - 1,
		stepNumber: index + 1,
		stepCount: steps.length,
		ready: state.ready,
		restored: state.restored,
		settlement: state.settlement,
		formError: state.formError,
		next,
		back,
		goTo,
		submit,
		applyFieldErrors,
		complete,
		discard,
	};
}

/** The field of `step` that owns the changed field `name`, or `null`. */
function ownerFieldOf<V extends FieldValues>(step: WizardStep<V>, name: string): FieldPath<V> | null {
	for (const field of step.fields) {
		const text = `${field}`;
		if (name === text || name.startsWith(`${text}.`) || text.startsWith(`${name}.`)) return field;
	}
	return null;
}

/** Runs a wizard on a console page: the URL through the App Router, the draft keyed by the viewer. */
export function useWizard<V extends FieldValues, TOut>(
	definition: WizardDefinition<V, TOut>,
	options: UseWizardOptions<V, TOut>,
): Wizard<V, TOut> {
	return useWizardEngine(definition, options, useWizardEnvironment());
}
