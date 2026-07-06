"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Paperclip, X } from "lucide-react";
import { useId, useRef } from "react";
import { Button } from "@repo/ui/button";
import {
	ATTACHMENT_ACCEPT,
	formatBytes,
	isAllowedAttachment,
	MAX_ATTACHMENT_BYTES,
} from "@/components/support/attachments";

interface AttachmentPickerProps {
	/** Currently-selected files (owned by the parent form). */
	files: File[];
	/** Replaces the selected-file list. */
	onChange: (files: File[]) => void;
	/** Reports a rejected file (bad type / too large) so the parent can toast. */
	onReject?: (reason: string) => void;
}

/**
 * Collects optional case attachments before submit. The files are held by the parent (not
 * uploaded here) and posted to the created case after submission. Rejects files outside the
 * allowlist or over the 10 MB cap client-side, reporting the reason via `onReject`.
 */
export function AttachmentPicker({ files, onChange, onReject }: AttachmentPickerProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();

	/** Validates + merges newly-picked files into the list, skipping invalid ones. */
	function handleSelected(selected: FileList | null) {
		if (!selected) return;
		const next = [...files];
		for (const file of Array.from(selected)) {
			if (!isAllowedAttachment(file)) {
				onReject?.(`${file.name}: unsupported file type`);
				continue;
			}
			if (file.size > MAX_ATTACHMENT_BYTES) {
				onReject?.(`${file.name}: exceeds the 10 MB limit`);
				continue;
			}
			if (next.some((f) => f.name === file.name && f.size === file.size)) continue;
			next.push(file);
		}
		onChange(next);
		if (inputRef.current) inputRef.current.value = "";
	}

	/** Removes one file from the list by index. */
	function removeAt(index: number) {
		onChange(files.filter((_, i) => i !== index));
	}

	return (
		<div className="space-y-2">
			<input
				ref={inputRef}
				id={inputId}
				type="file"
				multiple
				accept={ATTACHMENT_ACCEPT}
				className="sr-only"
				onChange={(e) => handleSelected(e.target.files)}
			/>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => inputRef.current?.click()}
			>
				<Paperclip className="h-4 w-4" />
				Add files
			</Button>
			<p className="text-xs text-muted-foreground">
				Images, PDF, text, JSON, or archives up to 10 MB each.
			</p>

			{files.length > 0 && (
				<ul className="space-y-1.5 pt-1">
					{files.map((file, i) => (
						<li
							key={`${file.name}-${file.size}`}
							className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
						>
							<span className="min-w-0 truncate">{file.name}</span>
							<span className="flex items-center gap-3 text-muted-foreground">
								<span className="text-xs">{formatBytes(file.size)}</span>
								<button
									type="button"
									aria-label={`Remove ${file.name}`}
									onClick={() => removeAt(i)}
									className="text-muted-foreground transition-colors hover:text-foreground"
								>
									<X className="h-4 w-4" />
								</button>
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
