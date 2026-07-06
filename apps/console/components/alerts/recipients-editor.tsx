"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A proper multi-email input: type an address and press Enter/comma (or paste a list) to
// add it as a chip; invalid addresses are rejected with an inline message; duplicates are
// ignored. Shared by the channel create sheet and the inline channel editor.

import { X } from "lucide-react";
import { useState } from "react";
import { z } from "zod";

const emailSchema = z.string().email();

interface RecipientsEditorProps {
	recipients: string[];
	editable: boolean;
	onChange: (recipients: string[]) => void;
}

/** A chip list of validated email recipients with inline add/remove. */
export function RecipientsEditor({
	recipients,
	editable,
	onChange,
}: RecipientsEditorProps) {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);

	if (!editable) {
		return recipients.length === 0 ? (
			<p className="text-muted-foreground text-sm">No recipients.</p>
		) : (
			<div className="flex flex-wrap gap-2">
				{recipients.map((r) => (
					<span
						key={r}
						className="rounded-full border border-border/60 bg-background px-3 py-1 font-mono text-muted-foreground text-xs"
					>
						{r}
					</span>
				))}
			</div>
		);
	}

	// Add one or more addresses (handles a pasted/comma/space-separated list).
	const commit = (raw: string) => {
		const candidates = raw
			.split(/[,\s]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (candidates.length === 0) return;
		const next = [...recipients];
		const invalid: string[] = [];
		for (const c of candidates) {
			if (!emailSchema.safeParse(c).success) invalid.push(c);
			else if (!next.includes(c)) next.push(c);
		}
		onChange(next);
		if (invalid.length > 0) {
			setError(`Not a valid email: ${invalid.join(", ")}`);
			setValue(invalid.join(", "));
		} else {
			setError(null);
			setValue("");
		}
	};

	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/20 p-2 focus-within:border-ring">
				{recipients.map((r) => (
					<span
						key={r}
						className="flex items-center gap-1.5 rounded-full border border-border/60 bg-background px-2.5 py-1 font-mono text-foreground text-xs"
					>
						{r}
						<button
							type="button"
							onClick={() => onChange(recipients.filter((x) => x !== r))}
							className="text-muted-foreground hover:text-foreground"
							aria-label={`Remove ${r}`}
						>
							<X className="size-3" />
						</button>
					</span>
				))}
				<input
					value={value}
					onChange={(e) => {
						setValue(e.target.value);
						if (error) setError(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === ",") {
							e.preventDefault();
							commit(value);
						} else if (
							e.key === "Backspace" &&
							value === "" &&
							recipients.length > 0
						) {
							onChange(recipients.slice(0, -1));
						}
					}}
					onBlur={() => value.trim() && commit(value)}
					onPaste={(e) => {
						const text = e.clipboardData.getData("text");
						if (/[,\s]/.test(text)) {
							e.preventDefault();
							commit(text);
						}
					}}
					placeholder={recipients.length === 0 ? "name@acme.cloud" : "Add another…"}
					className="min-w-[160px] flex-1 bg-transparent p-1 text-sm outline-none placeholder:text-muted-foreground"
				/>
			</div>
			{error && <p className="text-destructive text-xs">{error}</p>}
		</div>
	);
}
