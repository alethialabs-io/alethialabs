"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type FormEvent, useEffect, useRef, useState } from "react";
import { Controller } from "react-hook-form";
import { toast } from "sonner";
import {
	type AbuseReportOutput,
	type AbuseReportValues,
	abuseReportSubmission,
	abuseReportWizard,
} from "@/components/support/abuse/abuse-report.wizard";
import { AttachmentPicker } from "@/components/support/attachment-picker";
import { ATTACHMENT_HINT } from "@/components/support/attachment-policy";
import { FieldMessage } from "@/components/support/field-message";
import { ATTACHMENTS_NOT_KEPT } from "@/components/support/submit/steps/step-details";
import { useSubmitCase } from "@/components/support/use-submit-case";
import { supportAbuseCategory } from "@/lib/db/schema/enums";
import { SUPPORT_ABUSE_CATEGORY_LABELS } from "@/lib/validations/support";
import type { WizardEnvironment, WizardLocation } from "@/lib/wizard/types";
import { useWizardEngine } from "@/lib/wizard/use-wizard";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { Skeleton } from "@repo/ui/skeleton";
import { Textarea } from "@repo/ui/textarea";
import { cn } from "@repo/ui/utils";
import { WizardFormError, WizardRestoredNotice } from "@repo/ui/wizard";

interface AbuseFormProps {
	/** Active org slug — scopes the draft and targets the redirect to `/{org}/~/support/cases/{id}`. */
	orgSlug: string;
	/** Pre-fills the notification email (the signed-in user's address). */
	defaultEmail?: string;
	/** The signed-in user's id, which keys the report's tab draft. Without it nothing is kept. */
	viewerId?: string | null;
}

/**
 * The report is one page, so the engine's URL is a place that holds nothing: no step is written to
 * the address bar, and a finished report has nothing there to clear.
 */
const NO_URL: WizardLocation = {
	read: () => null,
	push: () => undefined,
	replace: () => undefined,
	leave: () => undefined,
};

/** The console context stamped onto a report when it is filed: where the person was, and the browser. */
function browserContext(): { consoleUrl: string; userAgent: string } {
	return { consoleUrl: window.location.href, userAgent: navigator.userAgent };
}

/**
 * The form's layout — its frame, its three sections and its fields — and its one line of copy.
 * {@link AbuseFormSkeleton} draws from these same constants, so the route's loading state and the
 * form are one layout and cannot drift apart (#6354, B2: the old skeleton was a generic five-field
 * stack, at least 313px shorter than the form, with neither its sections nor its rules).
 */
const FORM = "max-w-2xl space-y-8 py-2";
const SECTION = "space-y-5";
const RULED_SECTION = "space-y-5 border-t pt-6";
const FIELD = "space-y-2";
const BUTTON_ROW = "flex justify-end border-t pt-6";
/** A narrow control (the selects, the resource and the email). */
const NARROW = "max-w-md";
/** A field's hint line, under its control. */
const HINT = "text-xs text-muted-foreground";
/**
 * The description box's floor. A floor rather than `rows`: the console's `Textarea` sizes to its
 * content (`field-sizing: content`), so a fixed floor is what makes the empty box one known height
 * — the height its placeholder in the skeleton draws (`h-40`; a test holds the two together).
 */
const DESCRIPTION_BOX = "min-h-40";
const DESCRIPTION =
	"Flag phishing, malware, spam, copyright, or other policy violations. Our trust & safety team reviews every report.";

/** Who is filing the report, relative to the abusive resource. */
const RELATIONSHIP_LABELS: Record<"third_party" | "affected_party", string> = {
	affected_party: "I'm directly affected",
	third_party: "I'm reporting on someone else's behalf",
};

/**
 * The focused abuse-report form. Collects the abuse-specific fields plus a subject, description and
 * notification email on one page; the fixed parts of every abuse report (type `abuse`, category
 * `other`, high severity) and the console context are added when it is filed. It runs on the wizard
 * engine as a one-step wizard (`abuse-report.wizard.ts`), which gives it:
 *   - a tab draft: a reload, Back or a detour brings the report back, with "Start over" (G-07);
 *   - server field refusals under their fields, and one that belongs to no field shown above the
 *     button rather than dropped (G-04).
 * Submits through `useSubmitCase` (the mutation contract), which attaches the evidence files to the
 * case once it exists, and routes to the created case thread. The fields the report can be filed
 * without say so in their label (G-15). Every validation message has its line reserved
 * (`FieldMessage`), so a message appearing never moves the submit button (F043).
 */
export function AbuseForm({ orgSlug, defaultEmail, viewerId }: AbuseFormProps) {
	// The engine calls this once every field passes; it points at the mutation after each render.
	const fileReport = useRef<(values: AbuseReportOutput) => void>(() => undefined);
	// Evidence files. Held beside the form, not in it: a `File` cannot be written into the draft,
	// and the field says so (as the new-case wizard's attachments step does).
	const [files, setFiles] = useState<File[]>([]);
	const env: WizardEnvironment = { location: NO_URL, viewerId: viewerId ?? null };
	const wizard = useWizardEngine<AbuseReportValues, AbuseReportOutput>(
		abuseReportWizard,
		{
			defaultValues: {
				subject: "",
				description: "",
				contact: { notifyEmail: defaultEmail ?? "" },
				abuse: { reporterRelationship: "affected_party" },
			},
			scope: orgSlug,
			onSubmit: (values) => fileReport.current(values),
		},
		env,
	);
	const {
		control,
		register,
		formState: { errors },
	} = wizard.form;

	const submit = useSubmitCase(orgSlug, {
		onValidationError: wizard.applyFieldErrors,
		onSuccess: () => wizard.complete(),
	});

	useEffect(() => {
		fileReport.current = (values) =>
			submit.submit({ values: abuseReportSubmission(values, browserContext()), files });
	});

	const pending = submit.isPending || submit.isSuccess;

	/** Enter or the button: validates every field, then files the report once. */
	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending) return;
		void wizard.submit();
	}

	return (
		<form onSubmit={onSubmit} className={FORM} noValidate>
			<PageToolbar description={DESCRIPTION} />
			{wizard.restored ? <WizardRestoredNotice onStartOver={wizard.discard} /> : null}

			<section className={SECTION}>
				<div className={FIELD}>
					<Label htmlFor="abuse-category">Category (optional)</Label>
					<Controller
						control={control}
						name="abuse.abuseCategory"
						render={({ field }) => (
							<Select value={field.value} onValueChange={field.onChange}>
								<SelectTrigger id="abuse-category" className={cn("w-full", NARROW)}>
									<SelectValue placeholder="Select a category" />
								</SelectTrigger>
								<SelectContent>
									{supportAbuseCategory.enumValues.map((value) => (
										<SelectItem key={value} value={value}>
											{SUPPORT_ABUSE_CATEGORY_LABELS[value]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					/>
				</div>

				<div className={FIELD}>
					<Label htmlFor="abuse-resource">Reported resource (optional)</Label>
					<Input
						id="abuse-resource"
						placeholder="URL, IP, domain, or resource identifier"
						className={NARROW}
						{...register("abuse.reportedResource")}
					/>
					<p className={HINT}>Where you saw the abusive content or activity.</p>
				</div>

				<div className={FIELD}>
					<Label htmlFor="abuse-relationship">Your relationship</Label>
					<Controller
						control={control}
						name="abuse.reporterRelationship"
						render={({ field }) => (
							<Select value={field.value} onValueChange={field.onChange}>
								<SelectTrigger id="abuse-relationship" className={cn("w-full", NARROW)}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="affected_party">
										{RELATIONSHIP_LABELS.affected_party}
									</SelectItem>
									<SelectItem value="third_party">
										{RELATIONSHIP_LABELS.third_party}
									</SelectItem>
								</SelectContent>
							</Select>
						)}
					/>
				</div>
			</section>

			<section className={RULED_SECTION}>
				<div className={FIELD}>
					<Label htmlFor="abuse-subject">Subject</Label>
					<Input
						id="abuse-subject"
						placeholder="Short summary of the report"
						aria-invalid={errors.subject ? true : undefined}
						aria-describedby="abuse-subject-message"
						{...register("subject")}
					/>
					<FieldMessage id="abuse-subject-message" message={errors.subject?.message} />
				</div>

				<div className={FIELD}>
					<Label htmlFor="abuse-description">Description</Label>
					<Textarea
						id="abuse-description"
						className={DESCRIPTION_BOX}
						placeholder="Describe the abuse, including any relevant details or evidence…"
						aria-invalid={errors.description ? true : undefined}
						aria-describedby="abuse-description-message"
						{...register("description")}
					/>
					<FieldMessage id="abuse-description-message" message={errors.description?.message} />
				</div>

				<div className={FIELD}>
					<Label>Evidence (optional)</Label>
					<AttachmentPicker
						files={files}
						onChange={setFiles}
						onReject={(reason) => toast.error(reason)}
					/>
					<p className={HINT}>{ATTACHMENTS_NOT_KEPT}</p>
				</div>
			</section>

			<section className={RULED_SECTION}>
				<div className={FIELD}>
					<Label htmlFor="abuse-email">Notification email</Label>
					<Input
						id="abuse-email"
						type="email"
						placeholder="you@company.com"
						className={NARROW}
						aria-invalid={errors.contact?.notifyEmail ? true : undefined}
						aria-describedby="abuse-email-message"
						{...register("contact.notifyEmail")}
					/>
					<FieldMessage id="abuse-email-message" message={errors.contact?.notifyEmail?.message} />
				</div>
			</section>

			<WizardFormError message={wizard.formError} />

			<div className={BUTTON_ROW}>
				<Button type="submit" disabled={pending}>
					{pending ? "Submitting…" : "Submit report"}
				</Button>
			</div>
		</form>
	);
}

/**
 * One field's loading form: its label line (the `Label`'s 14px `leading-none` box), its control at
 * the control's own height, then its hint line or its reserved validation line, as the field has them.
 */
function FieldSkeleton({ control, hint = false, message = false }: { control: string; hint?: boolean; message?: boolean }) {
	return (
		<div className={FIELD}>
			<Skeleton className="h-3.5 w-28" />
			<Skeleton className={cn("w-full rounded-none", control)} />
			{hint ? (
				<div className="flex h-4 items-center">
					<Skeleton className="h-3 w-56" />
				</div>
			) : null}
			{message ? <FieldMessage /> : null}
		</div>
	);
}

/**
 * The evidence field's loading form: its label line, the picker's `size="sm"` "Add files" button
 * (32px), and the two static lines the field always shows — the picker's allowlist hint and the
 * draft note — as their real copy, so they wrap where the page's do.
 */
function EvidenceSkeleton() {
	return (
		<div className={FIELD}>
			<Skeleton className="h-3.5 w-28" />
			<div className="space-y-2">
				<Skeleton className="h-8 w-28 rounded-none" />
				<p className={HINT}>{ATTACHMENT_HINT}</p>
			</div>
			<p className={HINT}>{ATTACHMENTS_NOT_KEPT}</p>
		</div>
	);
}

/**
 * The abuse-report route's loading form (#6354, B2): the form's own frame, its real line of copy
 * (static, so it wraps where the page's does), each section with its rule and each field at its
 * control's height — the selects and inputs `h-9`, the description at its floor — and the submit
 * row. Built from the constants the form renders with, so the two cannot disagree.
 */
export function AbuseFormSkeleton() {
	return (
		<SkeletonRoot className={FORM}>
			<PageToolbar description={DESCRIPTION} />

			<div className={SECTION}>
				<FieldSkeleton control={cn("h-9", NARROW)} />
				<FieldSkeleton control={cn("h-9", NARROW)} hint />
				<FieldSkeleton control={cn("h-9", NARROW)} />
			</div>

			<div className={RULED_SECTION}>
				<FieldSkeleton control="h-9" message />
				<FieldSkeleton control="h-40" message />
				<EvidenceSkeleton />
			</div>

			<div className={RULED_SECTION}>
				<FieldSkeleton control={cn("h-9", NARROW)} message />
			</div>

			<div className={BUTTON_ROW}>
				<Skeleton className="h-9 w-32 rounded-none" />
			</div>
		</SkeletonRoot>
	);
}
