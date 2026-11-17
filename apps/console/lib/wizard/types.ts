// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The wizard engine's contract. Types only: a definition file (`*.wizard.ts`) and a component
// both import from here, and neither pulls in React or the router by doing so.

import type { StepperItem } from "@repo/ui/wizard";
import type { DefaultValues, FieldPath, FieldValues, UseFormReturn } from "react-hook-form";
import type { z } from "zod";
import type { FieldErrors } from "@/lib/actions/result";

/** What the server says about a step that cannot be undone (a charge, a trial start). */
export type Settlement =
	| { readonly kind: "not-started" }
	| { readonly kind: "in-flight"; readonly message: string }
	/** `continueAt` is a step id of this wizard, or an absolute path to leave for. */
	| { readonly kind: "done"; readonly continueAt: string }
	| { readonly kind: "stopped"; readonly message: string }
	/** The check itself failed. Never read as "not-started". */
	| { readonly kind: "unknown"; readonly message: string };

/** What a step waits on besides its own fields. */
export type StepGate =
	/** A round trip through another site. `returnParams` are the query params it comes back with. */
	| { readonly kind: "external"; readonly returnParams: readonly string[] }
	/** A step the user must never be asked to repeat. `settle` asks the server where it stands. */
	| { readonly kind: "irreversible"; readonly settle: () => Promise<Settlement> };

/** One step of a wizard. */
export interface WizardStep<V extends FieldValues> {
	readonly id: string;
	readonly label: string;
	/** The fields this step owns. Every key of the submit schema is owned by exactly one step. */
	readonly fields: readonly FieldPath<V>[];
	/** Parses the whole values object; a `z.object` drops the other steps' keys. */
	readonly schema: z.ZodType;
	/** `false`: the step is skipped — not shown, not validated. */
	readonly when?: (values: V) => boolean;
	readonly gate?: StepGate;
}

/** What a wizard may keep across a refresh. */
export interface WizardDraft {
	readonly version: number;
	/**
	 * THE ALLOWLIST. Only the keys this object schema names are written, and only as the plain
	 * values it parses them to. A field it does not name is never stored.
	 */
	readonly schema: z.ZodType;
	readonly ttlMinutes: number;
}

/** A wizard: its steps, its submit contract and what it may keep. */
export interface WizardDefinition<V extends FieldValues, TOut> {
	/** The URL and storage namespace. */
	readonly id: string;
	readonly presentation: "page" | "overlay";
	/** The submit contract, with the rules that span steps. */
	readonly schema: z.ZodType<TOut, V>;
	readonly steps: readonly WizardStep<V>[];
	/** `null` must be written; it cannot be omitted. */
	readonly draft: WizardDraft | null;
}

/** The engine's only way to the URL, so the engine itself never imports a router. */
export interface WizardLocation {
	read(name: string): string | null;
	/** A user's Next or Back: a new history entry. */
	push(patch: Readonly<Record<string, string | null>>): void;
	/** A clamp or a clean-up: no history entry. */
	replace(patch: Readonly<Record<string, string | null>>): void;
	/** Leaves the wizard for an absolute path, when a settled step says the flow continues elsewhere. */
	leave(path: string): void;
}

/** What the engine needs from the page around it. */
export interface WizardEnvironment {
	readonly location: WizardLocation;
	/**
	 * Who is signed in. `undefined` while that is not known yet — the engine waits. `null` when
	 * nobody is, in which case no draft is read or written.
	 */
	readonly viewerId: string | null | undefined;
	/** The clock, in epoch milliseconds. Injected by tests. */
	readonly now?: () => number;
}

/** What a component passes to `useWizard`. */
export interface UseWizardOptions<V extends FieldValues, TOut> {
	readonly defaultValues: DefaultValues<V>;
	/** What the draft belongs to: an org slug, a project id. The engine prepends the viewer id. */
	readonly scope: string;
	/** Called with the parsed values once every step and the submit schema pass. Calls `mutation.mutate`. */
	readonly onSubmit: (values: TOut) => void;
}

/** A running wizard. */
export interface Wizard<V extends FieldValues, TOut> {
	readonly form: UseFormReturn<V, unknown, TOut>;
	readonly items: readonly StepperItem[];
	readonly current: WizardStep<V>;
	readonly isLast: boolean;
	/** The 1-based position of `current` among the steps shown. */
	readonly stepNumber: number;
	/** How many steps are shown. */
	readonly stepCount: number;
	/**
	 * False until the draft has been read and every irreversible step has been asked where it
	 * stands. A component renders a placeholder, not the step, while this is false.
	 */
	readonly ready: boolean;
	readonly restored: boolean;
	readonly settlement: Settlement | null;
	/** Issues that belong to no visible field. */
	readonly formError: string | null;
	next(): Promise<void>;
	back(): void;
	goTo(id: string): void;
	submit(): Promise<void>;
	/** A mutation's `onValidationError`. */
	applyFieldErrors(fields: FieldErrors): void;
	/** A mutation's `onSuccess`: clears the draft and the wizard's params. */
	complete(): void;
	discard(): void;
}
