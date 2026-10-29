"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Controller, useFormContext } from "react-hook-form";
import { supportCaseType } from "@/lib/db/schema/enums";
import { RadioCard, RadioCardSkeleton } from "@/components/support/radio-card";
import {
	SUPPORT_CASE_TYPE_LABELS,
	type SubmitCaseInput,
} from "@/lib/validations/support";
import { SectionHeading } from "@repo/ui/section-heading";
import { FieldMessage } from "@/components/support/field-message";

/** One-line description per case type, shown under each radio card. */
const TYPE_DESCRIPTIONS: Record<string, string> = {
	technical: "Something in the platform isn't working as expected.",
	billing: "Invoices, plans, seats, or payment questions.",
	account: "Access, login, org, or membership issues.",
	general: "Anything else — questions or guidance.",
	abuse: "Report phishing, malware, spam, or policy violations.",
};

/** The step's frame and the cards' grid — shared with {@link StepTypeSkeleton} (#6354). */
const STEP = "space-y-4";
const GRID = "grid gap-2 sm:grid-cols-2";

/** The step's heading. Static copy, so the skeleton draws the real one rather than a guess at it. */
function StepTypeHeading() {
	return (
		<SectionHeading
			level={2}
			title="What kind of case is this?"
			description="This helps us route your case to the right team."
		/>
	);
}

/** Step 1 — pick the case type (radio cards driven by SUPPORT_CASE_TYPE_LABELS). */
export function StepType() {
	const {
		control,
		formState: { errors },
	} = useFormContext<SubmitCaseInput>();

	return (
		<div className={STEP}>
			<StepTypeHeading />
			<Controller
				control={control}
				name="type"
				render={({ field }) => (
					<div className={GRID}>
						{supportCaseType.enumValues.map((value) => (
							<RadioCard
								key={value}
								selected={field.value === value}
								onSelect={() => field.onChange(value)}
								label={SUPPORT_CASE_TYPE_LABELS[value]}
								description={TYPE_DESCRIPTIONS[value]}
							/>
						))}
					</div>
				)}
			/>
			<FieldMessage message={errors.type ? "Select a case type to continue." : undefined} />
		</div>
	);
}

/**
 * Step 1's loading form — what the new-case route paints before its form arrives (#6354, B2). The
 * same heading, the same grid with one {@link RadioCardSkeleton} per case type carrying that type's
 * own copy (so the cards wrap, and the rows stand, exactly as the real ones do — two columns from
 * `sm`), and the reserved validation line.
 */
export function StepTypeSkeleton() {
	return (
		<div className={STEP}>
			<StepTypeHeading />
			<div className={GRID}>
				{supportCaseType.enumValues.map((value) => (
					<RadioCardSkeleton
						key={value}
						label={SUPPORT_CASE_TYPE_LABELS[value]}
						description={TYPE_DESCRIPTIONS[value]}
					/>
				))}
			</div>
			<FieldMessage />
		</div>
	);
}
