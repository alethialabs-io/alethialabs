"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import { copyText } from "./copy-text";
import { cn } from "./utils";

/** An icon button that copies `text`, showing a check once the copy succeeded. */
export function CopyButton({
	text,
	className,
}: {
	text: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(async () => {
		// `copyText` falls back to a selection copy where the Clipboard API is absent (plain HTTP),
		// and the check only shows when the text really was copied.
		if (!(await copyText(text))) return;
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}, [text]);

	return (
		<button
			type="button"
			onClick={handleCopy}
			className={cn(
				"text-muted-foreground transition-colors hover:text-foreground",
				className,
			)}
			aria-label="Copy to clipboard"
		>
			{copied ? (
				<Check className="h-4 w-4 text-foreground" />
			) : (
				<Copy className="h-4 w-4" />
			)}
		</button>
	);
}
