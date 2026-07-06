"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Controller, useFormContext } from "react-hook-form";
import { supportCaseType } from "@/lib/db/schema/enums";
import { RadioCard } from "@/components/support/radio-card";
import {
	SUPPORT_CASE_TYPE_LABELS,
	type SubmitCaseInput,
} from "@/lib/validations/support";

/** One-line description per case type, shown under each radio card. */
const TYPE_DESCRIPTIONS: Record<string, string> = {
	technical: "Something in the platform isn't working as expected.",
	billing: "Invoices, plans, seats, or payment questions.",
	account: "Access, login, org, or membership issues.",
	general: "Anything else — questions or guidance.",
	abuse: "Report phishing, malware, spam, or policy violations.",
};

/** Step 1 — pick the case type (radio cards driven by SUPPORT_CASE_TYPE_LABELS). */
export function StepType() {
	const {
		control,
		formState: { errors },
	} = useFormContext<SubmitCaseInput>();

	return (
		<div className="space-y-4">
			<div className="space-y-1">
				<h2 className="text-lg font-medium">What kind of case is this?</h2>
				<p className="text-sm text-muted-foreground">
					This helps us route your case to the right team.
				</p>
			</div>
			<Controller
				control={control}
				name="type"
				render={({ field }) => (
					<div className="grid gap-2 sm:grid-cols-2">
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
			{errors.type && (
				<p className="text-xs text-destructive">Select a case type to continue.</p>
			)}
		</div>
	);
}
