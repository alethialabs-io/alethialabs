"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { type FieldPath, FormProvider, useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { z } from "zod";
import { submitCase } from "@/app/server/actions/support";
import { uploadAttachment } from "@/components/support/attachments";
import { StepCategory } from "@/components/support/submit/steps/step-category";
import { StepContact } from "@/components/support/submit/steps/step-contact";
import { StepDetails } from "@/components/support/submit/steps/step-details";
import { StepSeverity } from "@/components/support/submit/steps/step-severity";
import { StepType } from "@/components/support/submit/steps/step-type";
import { globalHref } from "@/lib/routing";
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
 * The AWS-style multi-step new-case form. A single `useForm<SubmitCaseInput>` drives all
 * steps (shared via `FormProvider`); each "Next" validates only the current step's fields.
 * On final submit it creates the case, best-effort uploads any collected attachments to the
 * new case, then routes to the case thread — a failed attachment toasts but never blocks the
 * redirect.
 */
export function SubmitCaseForm({ orgSlug, defaultEmail }: SubmitCaseFormProps) {
	const router = useRouter();
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
	const {
		handleSubmit,
		trigger,
		setValue,
		formState: { isSubmitting },
	} = form;

	// Snapshot the browser context (deep link + UA) for triage.
	useEffect(() => {
		setValue("context.consoleUrl", window.location.href);
		setValue("context.userAgent", navigator.userAgent);
	}, [setValue]);

	const isLastStep = step === STEP_LABELS.length - 1;

	/** Validates the current step, then advances. */
	async function handleNext() {
		const valid = await trigger(STEP_FIELDS[step]);
		if (valid) setStep((s) => Math.min(s + 1, STEP_LABELS.length - 1));
	}

	/** Creates the case, uploads attachments best-effort, then routes to the thread. */
	const onSubmit = handleSubmit(async (values) => {
		try {
			const { id } = await submitCase(values);
			for (const file of files) {
				try {
					await uploadAttachment(id, file);
				} catch {
					toast.error(`Couldn't attach ${file.name}. You can add it later.`);
				}
			}
			router.push(`${globalHref(orgSlug, "support")}/cases/${id}`);
		} catch {
			toast.error("Couldn't submit your case. Please try again.");
		}
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
						<Button
							type="button"
							variant="ghost"
							onClick={() => setStep((s) => Math.max(s - 1, 0))}
							disabled={step === 0 || isSubmitting}
						>
							Back
						</Button>
						{isLastStep ? (
							<Button type="submit" disabled={isSubmitting}>
								{isSubmitting ? "Submitting…" : "Submit case"}
							</Button>
						) : (
							<Button type="button" onClick={handleNext}>
								Continue
							</Button>
						)}
					</div>
				</form>
			</div>
		</FormProvider>
	);
}
