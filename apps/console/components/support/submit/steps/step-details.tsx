"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useFormContext } from "react-hook-form";
import { AttachmentPicker } from "@/components/support/attachment-picker";
import type { SubmitCaseWizardValues } from "@/components/support/submit/submit-case.wizard";
import { FieldMessage } from "@/components/support/field-message";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { Textarea } from "@repo/ui/textarea";

/**
 * What the attachments field says about the draft. A file cannot be kept across a reload — the
 * draft holds only what can be written down — so the person is told before it matters.
 */
export const ATTACHMENTS_NOT_KEPT = "Files are not kept in your draft: re-attach them after a reload.";

interface StepDetailsProps {
	/** Selected attachment files (owned by the parent form). */
	files: File[];
	/** Replaces the attachment list. */
	onFilesChange: (files: File[]) => void;
	/** Reports a rejected file so the parent can toast. */
	onFileReject: (reason: string) => void;
}

/** Step 4 — subject, description, and optional attachments. */
export function StepDetails({ files, onFilesChange, onFileReject }: StepDetailsProps) {
	const {
		register,
		formState: { errors },
	} = useFormContext<SubmitCaseWizardValues>();

	return (
		<div className="space-y-5">
			<div className="space-y-2">
				<Label htmlFor="support-subject">Subject</Label>
				<Input
					id="support-subject"
					placeholder="Short summary of the issue"
					aria-invalid={errors.subject ? true : undefined}
					aria-describedby="support-subject-message"
					{...register("subject")}
				/>
				<FieldMessage id="support-subject-message" message={errors.subject?.message} />
			</div>

			<div className="space-y-2">
				<Label htmlFor="support-description">Description</Label>
				<Textarea
					id="support-description"
					rows={7}
					placeholder="What happened, what you expected, and any steps to reproduce…"
					aria-invalid={errors.description ? true : undefined}
					aria-describedby="support-description-message"
					{...register("description")}
				/>
				<FieldMessage
					id="support-description-message"
					message={errors.description?.message}
				/>
			</div>

			<div className="space-y-2">
				<Label>Attachments (optional)</Label>
				<AttachmentPicker
					files={files}
					onChange={onFilesChange}
					onReject={onFileReject}
				/>
				<p data-slot="attachments-not-kept" className="text-xs text-muted-foreground">
					{ATTACHMENTS_NOT_KEPT}
				</p>
			</div>
		</div>
	);
}
