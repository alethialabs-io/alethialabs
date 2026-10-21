"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Check, Copy, X } from "lucide-react";
import { useCallback, useState } from "react";
import { copyText } from "./copy-text";
import { cn } from "./utils";

/** What a copy control says when the copy did not happen (no clipboard access, or a refusal). */
export const COPY_FAILED_MESSAGE = "Couldn't copy — select and copy manually";

/**
 * An icon button that copies `text`. It shows a check only once the copy really happened, and
 * says so when it did not, so the person knows to select the value and copy it by hand.
 */
export function CopyButton({
	text,
	className,
}: {
	text: string;
	className?: string;
}) {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

	const handleCopy = useCallback(async () => {
		// `copyText` falls back to a selection copy where the Clipboard API is absent (plain HTTP).
		const next = (await copyText(text)) ? "copied" : "failed";
		setState(next);
		setTimeout(() => setState("idle"), next === "copied" ? 2000 : 4000);
	}, [text]);

	const label = state === "failed" ? COPY_FAILED_MESSAGE : "Copy to clipboard";
	return (
		<button
			type="button"
			onClick={handleCopy}
			className={cn(
				"text-muted-foreground transition-colors hover:text-foreground",
				className,
			)}
			aria-label={label}
			title={state === "failed" ? COPY_FAILED_MESSAGE : undefined}
		>
			{state === "copied" ? (
				<Check className="h-4 w-4 text-foreground" />
			) : state === "failed" ? (
				<X className="h-4 w-4 text-destructive" />
			) : (
				<Copy className="h-4 w-4" />
			)}
			{state === "failed" && (
				<span role="status" className="sr-only">
					{COPY_FAILED_MESSAGE}
				</span>
			)}
		</button>
	);
}
