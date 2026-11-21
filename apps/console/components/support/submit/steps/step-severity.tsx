"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Controller, useFormContext } from "react-hook-form";
import { ChoiceCards } from "@/components/support/submit/choice-cards";
import type { SubmitCaseWizardValues } from "@/components/support/submit/submit-case.wizard";
import { FieldMessage } from "@/components/support/field-message";
import { supportCaseSeverity } from "@/lib/db/schema/enums";
import {
	SUPPORT_SEVERITY_GUIDANCE,
	SUPPORT_SEVERITY_LABELS,
} from "@/lib/validations/support";

/** The cards, most urgent last, with each option's expected-response guidance. */
const SEVERITY_OPTIONS = supportCaseSeverity.enumValues.map((value) => ({
	value,
	label: SUPPORT_SEVERITY_LABELS[value],
	description: SUPPORT_SEVERITY_GUIDANCE[value],
}));

/** Step 3 — pick severity, with per-option expected-response guidance. */
export function StepSeverity() {
	const {
		control,
		formState: { errors },
	} = useFormContext<SubmitCaseWizardValues>();

	return (
		<div className="space-y-4">
			<Controller
				control={control}
				name="severity"
				render={({ field }) => (
					<ChoiceCards
						label="Severity"
						name="support-severity"
						options={SEVERITY_OPTIONS}
						value={supportCaseSeverity.enumValues.find((value) => value === field.value)}
						onChange={field.onChange}
						inputRef={field.ref}
						invalid={errors.severity !== undefined}
						describedBy="support-severity-message"
						className="grid gap-2"
					/>
				)}
			/>
			<FieldMessage
				id="support-severity-message"
				message={errors.severity ? "Select a severity to continue." : undefined}
			/>
		</div>
	);
}
