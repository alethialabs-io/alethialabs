"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Controller, useFormContext } from "react-hook-form";
import type { SubmitCaseWizardValues } from "@/components/support/submit/submit-case.wizard";
import { FieldMessage } from "@/components/support/field-message";
import { supportCaseCategory } from "@/lib/db/schema/enums";
import { SUPPORT_CATEGORY_LABELS } from "@/lib/validations/support";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";

/**
 * Step 2 — pick the service / area the case is about. A plain select for now; a resource-aware
 * picker (link a specific cluster/job/connector) is a later enhancement.
 */
export function StepCategory() {
	const {
		control,
		formState: { errors },
	} = useFormContext<SubmitCaseWizardValues>();

	return (
		<div className="space-y-2">
			<Label htmlFor="support-category">Service / area</Label>
			<Controller
				control={control}
				name="category"
				render={({ field }) => (
					<Select value={field.value} onValueChange={field.onChange}>
						<SelectTrigger
							id="support-category"
							ref={field.ref}
							className="w-full max-w-md"
							aria-invalid={errors.category ? true : undefined}
							aria-describedby="support-category-message"
						>
							<SelectValue placeholder="Select an area" />
						</SelectTrigger>
						<SelectContent>
							{supportCaseCategory.enumValues.map((value) => (
								<SelectItem key={value} value={value}>
									{SUPPORT_CATEGORY_LABELS[value]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
			/>
			<FieldMessage
				id="support-category-message"
				message={errors.category ? "Select an area to continue." : undefined}
			/>
		</div>
	);
}
