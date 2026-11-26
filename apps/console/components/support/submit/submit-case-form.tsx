"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type FormEvent, useEffect, useRef, useState } from "react";
import { FormProvider } from "react-hook-form";
import { toast } from "sonner";
import { StepCategory } from "@/components/support/submit/steps/step-category";
import { StepContact } from "@/components/support/submit/steps/step-contact";
import { StepDetails } from "@/components/support/submit/steps/step-details";
import { StepSeverity } from "@/components/support/submit/steps/step-severity";
import { StepType, StepTypeSkeleton } from "@/components/support/submit/steps/step-type";
import {
	type SubmitCaseWizardOutput,
	type SubmitCaseWizardValues,
	submitCaseWizard,
} from "@/components/support/submit/submit-case.wizard";
import { useSubmitCase } from "@/components/support/use-submit-case";
import { track } from "@/lib/analytics/track";
import { globalHref } from "@/lib/routing";
import { useWizard } from "@/lib/wizard/use-wizard";
import { SectionHeading } from "@repo/ui/section-heading";
import { Skeleton } from "@repo/ui/skeleton";
import {
	type StepperItem,
	Stepper,
	WizardFooter,
	WizardFormError,
	WizardRestoredNotice,
	WizardStepHeading,
} from "@repo/ui/wizard";

interface SubmitCaseFormProps {
	/** Active org slug — scopes the draft and targets the post-submit redirect to the case. */
	orgSlug: string;
	/** Pre-fills the notification email (the signed-in user's address). */
	defaultEmail?: string;
}

/** The step rail's accessible name. */
const STEPPER_LABEL = "New support case";

/** The heading and one line of copy each step opens with. */
interface StepCopy {
	readonly title: string;
	readonly description: string;
}

/** Each step's heading, by step id. */
const STEP_COPY: Readonly<Record<string, StepCopy>> = {
	type: {
		title: "What kind of case is this?",
		description: "This helps us route your case to the right team.",
	},
	area: {
		title: "Which area is this about?",
		description: "Pick the service or area closest to your issue.",
	},
	severity: {
		title: "How severe is this?",
		description: "Set the urgency so we can prioritize your case.",
	},
	details: {
		title: "Tell us what's happening",
		description: "A clear subject and detailed description help us resolve this faster.",
	},
	contact: {
		title: "How should we reach you?",
		description: "We'll send case updates to this address.",
	},
};

/** What a step without its own copy would show; never reached while every step id is above. */
const FALLBACK_COPY: StepCopy = { title: "New support case", description: "" };

/** Why Continue is disabled on a choice step whose choice is still unmade, by step index. */
const UNANSWERED_REASON = [
	"Choose a case type to continue.",
	"Choose an area to continue.",
	"Choose a severity to continue.",
] as const;

/**
 * The wizard's frame and its button row — shared with {@link SubmitCaseFormSkeleton}, so the
 * route's loading state and the form it stands in for are one layout (#6354).
 */
const FRAME = "space-y-8 py-2";
const STEP_BODY = "space-y-4";
const BUTTON_ROW = "mt-8 border-t pt-6";

/** The rail as it stands on a fresh first step: the first step current, the rest not started. */
const FIRST_STEP_ITEMS: readonly StepperItem[] = submitCaseWizard.steps.map((step, index) => ({
	id: step.id,
	label: step.label,
	state: index === 0 ? "current" : "todo",
}));

/**
 * Whether the step at `step` (0-based) has an answer to validate at all. A step whose one choice is
 * still unmade (no type, no area) cannot go on, so its Continue is disabled — with the reason said —
 * rather than enabled and then refused (F043). Text steps are not gated here: Continue validates
 * them, and the message lands in a line that is already reserved, so nothing moves.
 */
export function stepAnswered(
	step: number,
	values: { type?: string; category?: string; severity?: string },
): boolean {
	if (step === 0) return Boolean(values.type);
	if (step === 1) return Boolean(values.category);
	if (step === 2) return Boolean(values.severity);
	return true;
}

/** The console context stamped onto a case when it is filed: where the person was, and the browser. */
function browserContext(): { consoleUrl: string; userAgent: string } {
	return { consoleUrl: window.location.href, userAgent: navigator.userAgent };
}

/**
 * The new-case wizard, on the shared wizard engine (`lib/wizard/`, definition in
 * `submit-case.wizard.ts`). What that gives this page, each one a fix:
 *   - the step is in the URL (`?step=details`) and the typed values are in a tab draft, so a
 *     reload, Back or a detour restores the case — attachments excepted, which the details step
 *     says (G-07);
 *   - a server field refusal lands on its field and takes the person to its step; a refusal no
 *     step owns is shown above the buttons instead of nowhere (G-04);
 *   - Continue and Submit are different buttons that cancel their click's default action, so the
 *     press that reaches the last step cannot also file the case (#6728) — the footer's guarantee,
 *     not a handler here.
 *
 * The case is filed through the mutation contract (`useSubmitCase`), which uploads the files
 * best-effort and routes to the case thread. While files are picked, leaving the page asks first:
 * they are the one thing the draft cannot keep.
 */
export function SubmitCaseForm({ orgSlug, defaultEmail }: SubmitCaseFormProps) {
	const [files, setFiles] = useState<File[]>([]);
	// The wizard calls this when every step passes; it is pointed at the mutation after each render.
	const fileCase = useRef<(values: SubmitCaseWizardOutput) => void>(() => undefined);

	const wizard = useWizard<SubmitCaseWizardValues, SubmitCaseWizardOutput>(submitCaseWizard, {
		defaultValues: {
			severity: "normal",
			subject: "",
			description: "",
			contact: { notifyEmail: defaultEmail ?? "", channel: "email" },
		},
		scope: orgSlug,
		onSubmit: (values) => fileCase.current(values),
	});

	const submit = useSubmitCase(orgSlug, {
		onValidationError: wizard.applyFieldErrors,
		onSuccess: () => {
			const category = wizard.form.getValues("category");
			if (category) track("support_case_opened", { category });
			wizard.complete();
		},
	});

	useEffect(() => {
		fileCase.current = (values) =>
			submit.submit({ values: { ...values, context: browserContext() }, files });
	});

	// Files cannot be kept in the draft, so a reload or a closed tab would drop them: ask first.
	const holdingFiles = files.length > 0 && !submit.isSuccess;
	useEffect(() => {
		if (!holdingFiles) return undefined;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [holdingFiles]);

	// Until the engine has read the draft (`ready`), the first step is drawn at its defaults and held
	// INERT, never swapped for the skeleton: the server render is then the page itself, so a first
	// paint whose hydration is slow (or stalled behind a held read) still shows the step's heading
	// and its Continue (B1). A restored draft replaces the values once read; nothing can be pressed
	// before then.
	const booting = !wizard.ready;

	const step = wizard.current.id;
	const index = wizard.stepNumber - 1;
	const copy = STEP_COPY[step] ?? FALLBACK_COPY;
	const answered = stepAnswered(index, wizard.form.getValues());
	const pending = submit.isPending || submit.isSuccess;

	/** Starts the case again: no draft, no files, the first step. */
	function startOver() {
		setFiles([]);
		wizard.discard();
	}

	/**
	 * Enter in a one-line field submits the form natively; that press means "go on", so it takes the
	 * same path as the primary button — Continue before the last step, Submit on it.
	 */
	function onEnter(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending) return;
		void (wizard.isLast ? wizard.submit() : wizard.next());
	}

	return (
		<FormProvider {...wizard.form}>
			<div className={FRAME} inert={booting} aria-busy={booting || undefined}>
				<Stepper label={STEPPER_LABEL} items={wizard.items} onSelect={wizard.goTo} />
				{wizard.restored ? <WizardRestoredNotice onStartOver={startOver} /> : null}

				<form onSubmit={onEnter} noValidate>
					<div className={STEP_BODY}>
						<WizardStepHeading
							title={copy.title}
							description={copy.description}
							position={wizard.stepNumber}
							total={wizard.stepCount}
							level={2}
						/>
						{step === "type" ? <StepType abuseHref={globalHref(orgSlug, "support/abuse")} /> : null}
						{step === "area" ? <StepCategory /> : null}
						{step === "severity" ? <StepSeverity /> : null}
						{step === "details" ? (
							<StepDetails
								files={files}
								onFilesChange={setFiles}
								onFileReject={(reason) => toast.error(reason)}
							/>
						) : null}
						{step === "contact" ? <StepContact attachmentCount={files.length} /> : null}
						<WizardFormError message={wizard.formError} />
					</div>

					<div className={BUTTON_ROW}>
						<WizardFooter
							back={wizard.stepNumber > 1 ? wizard.back : null}
							primary={
								wizard.isLast
									? { kind: "submit", label: "Submit case", onPress: () => void wizard.submit() }
									: { kind: "next", label: "Continue", onPress: () => void wizard.next() }
							}
							pending={pending}
							disabledReason={answered ? undefined : UNANSWERED_REASON[index]}
						/>
					</div>
				</form>
			</div>
		</FormProvider>
	);
}

/**
 * The new-case route's loading form (#6354, B2): the wizard's frame on its first step — the real rail, step 1's heading and {@link StepTypeSkeleton}
 * (the type cards in their own grid, with their own copy) and the button row with a Continue-sized
 * placeholder where the primary button stands.
 */
export function SubmitCaseFormSkeleton() {
	const copy = STEP_COPY.type ?? FALLBACK_COPY;
	return (
		<div className={FRAME} aria-busy="true">
			<Stepper label={STEPPER_LABEL} items={FIRST_STEP_ITEMS} />
			<div>
				<div className={STEP_BODY}>
					<SectionHeading level={2} title={copy.title} description={copy.description} />
					<StepTypeSkeleton />
				</div>
				<div className={BUTTON_ROW}>
					<div className="flex items-center justify-end">
						<Skeleton className="h-9 w-24 rounded-none" />
					</div>
				</div>
			</div>
		</div>
	);
}
