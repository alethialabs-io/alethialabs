"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { z } from "zod";
import { submitCase } from "@/app/server/actions/support";
import { uploadAttachment } from "@/components/support/attachments";
import { supportCaseKeys } from "@/components/support/cases/case-queries";
import type { ActionResult, FieldErrors } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { globalHref } from "@/lib/routing";
import type { submitCaseSchema } from "@/lib/validations/support";

/** What a submit sends: the validated case plus any files to attach once it exists. */
export interface SubmitCaseVariables {
	values: z.input<typeof submitCaseSchema>;
	files?: File[];
}

/**
 * Opening a case, for every form that opens one — the wizard, the abuse report and the assistant's
 * approval card — through the mutation contract (`useActionMutation`). In flight it is pending (bind
 * the submit button's `disabled` to `isPending`: the double-submit guard); a validation refusal is
 * handed to the form's own fields; on success the attachments upload best-effort (a failed file
 * toasts, never blocks), every key that shows a case is invalidated — so the new case is in "My
 * cases" and the bell when the viewer gets there — and the viewer lands on the new case's thread,
 * which is the confirmation.
 */
export function useSubmitCase(
	orgSlug: string,
	opts: {
		onValidationError?: (fields: FieldErrors) => void;
		/** Navigate to the new case (default) — the approval card stays in the chat instead. */
		navigate?: boolean;
		onSuccess?: (created: { id: string; caseNumber: number }) => void;
	} = {},
) {
	const router = useRouter();
	const navigate = opts.navigate ?? true;
	return useActionMutation(
		async ({ values, files = [] }: SubmitCaseVariables): Promise<
			ActionResult<{ id: string; caseNumber: number }>
		> => {
			const result = await submitCase(values);
			if (result.ok) {
				for (const file of files) {
					try {
						await uploadAttachment(result.data.id, file);
					} catch {
						toast.error(`Couldn't attach ${file.name}. You can add it later.`);
					}
				}
			}
			return result;
		},
		{
			invalidates: supportCaseKeys(),
			onValidationError: opts.onValidationError,
			onSuccess: (created) => {
				opts.onSuccess?.(created);
				if (navigate) router.push(`${globalHref(orgSlug, "support")}/cases/${created.id}`);
			},
		},
	);
}
