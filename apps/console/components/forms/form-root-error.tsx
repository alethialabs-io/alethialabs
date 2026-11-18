// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { Alert, AlertDescription } from "@repo/ui/alert";
import { type FieldValues, type UseFormReturn, useFormState } from "react-hook-form";

/** Props for {@link FormRootError}. */
export interface FormRootErrorProps<F extends FieldValues> {
	/** The form whose `root.server` error is shown. */
	form: UseFormReturn<F>;
	/** Extra classes for the alert, for the spacing the surrounding form uses. */
	className?: string;
}

/**
 * Shows a form's `root.server` error: the server messages that belong to no field the form
 * renders. `useActionMutation` writes it when the mutation is given the form. Renders nothing
 * while there is no such error. react-hook-form clears root errors on the next submit.
 */
export function FormRootError<F extends FieldValues>({ form, className }: FormRootErrorProps<F>) {
	const { errors } = useFormState({ control: form.control });
	const message = errors.root?.server?.message;
	if (!message) return null;
	return (
		<Alert variant="destructive" className={className}>
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	);
}
