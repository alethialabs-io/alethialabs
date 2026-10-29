"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { type FieldPath, Controller, useForm } from "react-hook-form";
import type { z } from "zod";
import { FieldMessage } from "@/components/support/field-message";
import { useSubmitCase } from "@/components/support/use-submit-case";
import { supportAbuseCategory } from "@/lib/db/schema/enums";
import {
	SUPPORT_ABUSE_CATEGORY_LABELS,
	type SubmitCaseInput,
	submitCaseSchema,
} from "@/lib/validations/support";
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
import { Skeleton } from "@repo/ui/skeleton";
import { Textarea } from "@repo/ui/textarea";
import { cn } from "@repo/ui/utils";

interface AbuseFormProps {
	/** Active org slug — targets the post-submit redirect to `/{org}/~/support/cases/{id}`. */
	orgSlug: string;
	/** Pre-fills the notification email (the signed-in user's address). */
	defaultEmail?: string;
}

/**
 * The form's raw field-value type — the pre-parse input shape of `submitCaseSchema`
 * (which transforms `contact.channel`), paired with the parsed {@link SubmitCaseInput}
 * output so `handleSubmit` yields the parsed values.
 */
type AbuseFormValues = z.input<typeof submitCaseSchema>;

/** The fields a server validation refusal may name (its keys are react-hook-form paths). */
const ABUSE_FIELDS: FieldPath<AbuseFormValues>[] = ["subject", "description", "contact.notifyEmail"];

/** True when a refusal's field key is one this form renders a message for. */
function isAbuseField(name: string): name is FieldPath<AbuseFormValues> {
	return ABUSE_FIELDS.some((field) => field === name);
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
 * The focused abuse-report form. Presets the shared submit contract to `type: "abuse"`
 * (category `other`, high severity) and collects the abuse-specific fields plus a subject,
 * description, and notification email in a single page. Submits through `useSubmitCase` (the
 * mutation contract) and routes to the created case thread. Every validation message has its line
 * reserved (`FieldMessage`), so a message appearing never moves the submit button (F043).
 */
export function AbuseForm({ orgSlug, defaultEmail }: AbuseFormProps) {
	const {
		control,
		register,
		handleSubmit,
		setValue,
		setError,
		formState: { errors },
	} = useForm<AbuseFormValues, unknown, SubmitCaseInput>({
		resolver: zodResolver(submitCaseSchema),
		defaultValues: {
			type: "abuse",
			category: "other",
			severity: "high",
			context: {},
			contact: { notifyEmail: defaultEmail ?? "", channel: "email" },
			abuse: { reporterRelationship: "affected_party" },
		},
	});

	const submit = useSubmitCase(orgSlug, {
		// A server-side validation refusal lands on the field it names, like a client-side one.
		onValidationError: (fields) => {
			for (const [name, messages] of Object.entries(fields)) {
				const message = messages?.[0];
				if (message && isAbuseField(name)) setError(name, { message });
			}
		},
	});

	// Snapshot the browser context (deep link + UA) for triage.
	useEffect(() => {
		setValue("context.consoleUrl", window.location.href);
		setValue("context.userAgent", navigator.userAgent);
	}, [setValue]);

	/** Creates the abuse case, then routes to the thread. */
	const onSubmit = handleSubmit((values) => {
		if (submit.isPending) return;
		submit.mutate({ values });
	});

	return (
		<form onSubmit={onSubmit} className={FORM}>
			<PageToolbar description={DESCRIPTION} />

			<section className={SECTION}>
				<div className={FIELD}>
					<Label htmlFor="abuse-category">Category</Label>
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
					<Label htmlFor="abuse-resource">Reported resource</Label>
					<Input
						id="abuse-resource"
						placeholder="URL, IP, domain, or resource identifier"
						className={NARROW}
						{...register("abuse.reportedResource")}
					/>
					<p className="text-xs text-muted-foreground">
						Where you saw the abusive content or activity.
					</p>
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
						{...register("subject")}
					/>
					<FieldMessage message={errors.subject?.message} />
				</div>

				<div className={FIELD}>
					<Label htmlFor="abuse-description">Description</Label>
					<Textarea
						id="abuse-description"
						className={DESCRIPTION_BOX}
						placeholder="Describe the abuse, including any relevant details or evidence…"
						{...register("description")}
					/>
					<FieldMessage message={errors.description?.message} />
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
						{...register("contact.notifyEmail")}
					/>
					<FieldMessage
						message={errors.contact?.notifyEmail ? "Enter a valid email address." : undefined}
					/>
				</div>
			</section>

			<div className={BUTTON_ROW}>
				<Button type="submit" disabled={submit.isPending}>
					{submit.isPending ? "Submitting…" : "Submit report"}
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
 * The abuse-report route's loading form (#6354, B2): the form's own frame, its real line of copy
 * (static, so it wraps where the page's does), each section with its rule and each field at its
 * control's height — the selects and inputs `h-9`, the description at its floor — and the submit
 * row. Built from the constants the form renders with, so the two cannot disagree.
 */
export function AbuseFormSkeleton() {
	return (
		<div className={FORM} aria-busy="true">
			<PageToolbar description={DESCRIPTION} />

			<div className={SECTION}>
				<FieldSkeleton control={cn("h-9", NARROW)} />
				<FieldSkeleton control={cn("h-9", NARROW)} />
				<FieldSkeleton control={cn("h-9", NARROW)} />
			</div>

			<div className={RULED_SECTION}>
				<FieldSkeleton control="h-9" message />
				<FieldSkeleton control="h-32" message />
			</div>

			<div className={RULED_SECTION}>
				<FieldSkeleton control={cn("h-9", NARROW)} message />
			</div>

			<div className={BUTTON_ROW}>
				<Skeleton className="h-9 w-32 rounded-none" />
			</div>
		</div>
	);
}
