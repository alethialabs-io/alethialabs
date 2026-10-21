"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { type FieldPath, FormProvider, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { track } from "@/lib/analytics/track";
import { useSubmitCase } from "@/components/support/use-submit-case";
import { StepCategory } from "@/components/support/submit/steps/step-category";
import { StepContact } from "@/components/support/submit/steps/step-contact";
import { StepDetails } from "@/components/support/submit/steps/step-details";
import { StepSeverity } from "@/components/support/submit/steps/step-severity";
import { StepType } from "@/components/support/submit/steps/step-type";
import {
	type SubmitCaseInput,
	submitCaseSchema,
} from "@/lib/validations/support";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";

interface SubmitCaseFormProps {
	/** Active org slug — targets the post-submit redirect to `/{org}/~/support/cases/{id}`. */
	orgSlug: string;
	/** Pre-fills the notification email (the signed-in user's address). */
	defaultEmail?: string;
}

/**
 * The form's raw field-value type. `submitCaseSchema` transforms on parse (`contact.channel`
 * has a default), so the input shape differs from the parsed {@link SubmitCaseInput} output;
 * `useForm` is typed with both so `handleSubmit` yields the parsed output.
 */
type SubmitCaseFormValues = z.input<typeof submitCaseSchema>;

/** Per-step labels for the stepper header. */
const STEP_LABELS = ["Type", "Area", "Severity", "Details", "Contact"] as const;

/** Fields validated (via RHF `trigger`) before advancing past each step. */
const STEP_FIELDS: FieldPath<SubmitCaseFormValues>[][] = [
	["type"],
	["category"],
	["severity"],
	["subject", "description"],
	["contact.notifyEmail", "contact.channel"],
];

/**
 * Whether the current step has an answer to validate at all. A step whose one choice is still
 * unmade (no type, no area) cannot go on, so its Continue is disabled rather than enabled and then
 * refused (F043). Text steps are not gated here: "Continue" validates them, and the message lands
 * in a line that is already reserved, so nothing moves.
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

/**
 * The AWS-style multi-step new-case form. A single `useForm<SubmitCaseInput>` drives all
 * steps (shared via `FormProvider`); each "Continue" validates only the current step's fields.
 * On final submit it creates the case through the mutation contract (`useSubmitCase`), best-effort
 * uploads any collected attachments to the new case, then routes to the case thread — a failed
 * attachment toasts but never blocks the redirect.
 *
 * The button row does not move (F043): there is no Back on the first step (its slot stays, empty),
 * Continue is disabled until the step's choice is made, and every step's validation message sits
 * in a line reserved for it.
 */
export function SubmitCaseForm({ orgSlug, defaultEmail }: SubmitCaseFormProps) {
	const [step, setStep] = useState(0);
	const [files, setFiles] = useState<File[]>([]);

	const form = useForm<SubmitCaseFormValues, unknown, SubmitCaseInput>({
		resolver: zodResolver(submitCaseSchema),
		defaultValues: {
			severity: "normal",
			context: {},
			contact: { notifyEmail: defaultEmail ?? "", channel: "email" },
		},
	});
	const { control, handleSubmit, trigger, setValue, setError } = form;
	const values = useWatch({ control });

	const submit = useSubmitCase(orgSlug, {
		// A server-side validation refusal lands on its field and takes the user to its step.
		onValidationError: (fields) => {
			for (const [name, messages] of Object.entries(fields)) {
				const at = STEP_FIELDS.findIndex((stepFields) => stepFields.some((f) => f === name));
				const message = messages?.[0];
				if (at === -1 || !message) continue;
				setError(STEP_FIELDS[at].find((f) => f === name) ?? STEP_FIELDS[at][0], { message });
				setStep((current) => Math.min(current, at));
			}
		},
		onSuccess: (_created) => {
			if (values.category) track("support_case_opened", { category: values.category });
		},
	});

	// Snapshot the browser context (deep link + UA) for triage.
	useEffect(() => {
		setValue("context.consoleUrl", window.location.href);
		setValue("context.userAgent", navigator.userAgent);
	}, [setValue]);

	const isLastStep = step === STEP_LABELS.length - 1;
	const answered = stepAnswered(step, values);

	/** Validates the current step, then advances. */
	async function handleNext() {
		const valid = await trigger(STEP_FIELDS[step]);
		if (valid) setStep((s) => Math.min(s + 1, STEP_LABELS.length - 1));
	}

	/** Creates the case (and its attachments) through the mutation contract. */
	const onSubmit = handleSubmit((parsed) => {
		if (submit.isPending) return;
		submit.mutate({ values: parsed, files });
	});

	return (
		<FormProvider {...form}>
			<div className="space-y-8 py-2">
				<nav aria-label="Progress" className="flex items-center gap-2">
					{STEP_LABELS.map((label, i) => (
						<div key={label} className="flex items-center gap-2">
							<span
								className={cn(
									"flex h-6 w-6 items-center justify-center rounded-full border text-xs",
									i === step
										? "border-foreground bg-foreground text-background"
										: i < step
											? "border-foreground/40 text-foreground"
											: "border-border text-muted-foreground",
								)}
							>
								{i + 1}
							</span>
							<span
								className={cn(
									"hidden text-sm sm:inline",
									i === step
										? "font-medium text-foreground"
										: "text-muted-foreground",
								)}
							>
								{label}
							</span>
							{i < STEP_LABELS.length - 1 && (
								<span className="mx-1 h-px w-4 bg-border sm:w-8" />
							)}
						</div>
					))}
				</nav>

				<form onSubmit={onSubmit}>
					{step === 0 && <StepType />}
					{step === 1 && <StepCategory />}
					{step === 2 && <StepSeverity />}
					{step === 3 && (
						<StepDetails
							files={files}
							onFilesChange={setFiles}
							onFileReject={(reason) => toast.error(reason)}
						/>
					)}
					{step === 4 && <StepContact attachmentCount={files.length} />}

					<div className="mt-8 flex items-center justify-between border-t pt-6">
						{/* No Back on the first step — there is nowhere to go back to — but the slot
						    stays, so Continue does not jump to the left edge of the row. */}
						{step === 0 ? (
							<span aria-hidden />
						) : (
							<Button
								type="button"
								variant="ghost"
								onClick={() => setStep((s) => Math.max(s - 1, 0))}
								disabled={submit.isPending}
							>
								Back
							</Button>
						)}
						{isLastStep ? (
							<Button type="submit" disabled={submit.isPending}>
								{submit.isPending ? "Submitting…" : "Submit case"}
							</Button>
						) : (
							<Button type="button" onClick={handleNext} disabled={!answered}>
								Continue
							</Button>
						)}
					</div>
				</form>
			</div>
		</FormProvider>
	);
}
