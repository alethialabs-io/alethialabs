"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { Controller, useFormContext } from "react-hook-form";
import { RadioCardSkeleton } from "@/components/support/radio-card";
import { ChoiceCards } from "@/components/support/submit/choice-cards";
import {
	type SubmitCaseWizardValues,
	WIZARD_CASE_TYPES,
	type WizardCaseType,
} from "@/components/support/submit/submit-case.wizard";
import { FieldMessage } from "@/components/support/field-message";
import { SUPPORT_CASE_TYPE_LABELS } from "@/lib/validations/support";

/** One-line description per case type, shown under each card. */
const TYPE_DESCRIPTIONS: Record<WizardCaseType, string> = {
	technical: "Something in the platform isn't working as expected.",
	billing: "Invoices, plans, seats, or payment questions.",
	account: "Access, login, org, or membership issues.",
	general: "Anything else — questions or guidance.",
};

/** The cards, in the order they are shown. */
const TYPE_OPTIONS = WIZARD_CASE_TYPES.map((value) => ({
	value,
	label: SUPPORT_CASE_TYPE_LABELS[value],
	description: TYPE_DESCRIPTIONS[value],
}));

/** The step's frame and the cards' grid — shared with {@link StepTypeSkeleton} (#6354). */
const STEP = "space-y-4";
const GRID = "grid gap-2 sm:grid-cols-2";
const ABUSE_LINE = "text-sm text-muted-foreground";

/** The question under which abuse is reported: its own form, not a case type here (G-14). */
const ABUSE_PROMPT = "Reporting phishing, malware, spam, or a policy violation?";

interface StepTypeProps {
	/** Where the dedicated abuse-report form lives. */
	abuseHref: string;
}

/**
 * Step 1 — pick the case type. Abuse is not one of the cards: it has a dedicated form that asks
 * what an abuse report needs, so the step links there instead (G-14).
 */
export function StepType({ abuseHref }: StepTypeProps) {
	const {
		control,
		formState: { errors },
	} = useFormContext<SubmitCaseWizardValues>();

	return (
		<div className={STEP}>
			<Controller
				control={control}
				name="type"
				render={({ field }) => (
					<ChoiceCards
						label="Case type"
						name="support-type"
						options={TYPE_OPTIONS}
						value={WIZARD_CASE_TYPES.find((value) => value === field.value)}
						onChange={field.onChange}
						inputRef={field.ref}
						invalid={errors.type !== undefined}
						describedBy="support-type-message"
						className={GRID}
					/>
				)}
			/>
			<FieldMessage
				id="support-type-message"
				message={errors.type ? "Select a case type to continue." : undefined}
			/>
			<p className={ABUSE_LINE}>
				{ABUSE_PROMPT}{" "}
				<Link
					href={abuseHref}
					className="rounded-sm text-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					Report abuse
				</Link>
			</p>
		</div>
	);
}

/**
 * Step 1's loading form — what the new-case route paints before its form arrives (#6354, B2). The
 * same grid with one {@link RadioCardSkeleton} per case type carrying that type's own copy (so the
 * cards wrap, and the rows stand, exactly as the real ones do — two columns from `sm`), the reserved
 * validation line and the abuse line.
 */
export function StepTypeSkeleton() {
	return (
		<div className={STEP}>
			<div className={GRID}>
				{TYPE_OPTIONS.map((option) => (
					<RadioCardSkeleton key={option.value} label={option.label} description={option.description} />
				))}
			</div>
			<FieldMessage />
			<p aria-hidden className={ABUSE_LINE}>
				{ABUSE_PROMPT} <span className="text-foreground underline underline-offset-4">Report abuse</span>
			</p>
		</div>
	);
}
