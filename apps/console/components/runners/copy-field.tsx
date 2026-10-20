"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { COPY_FAILED_MESSAGE } from "@repo/ui/copy-button";
import { copyText } from "@repo/ui/copy-text";
import { Label } from "@repo/ui/label";
import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";

/**
 * A read-only value with a copy button. When the copy does not happen (no clipboard access, or a
 * modal focus trap that left nothing selected) it says so and selects the value, so the person can
 * copy it by hand: the runner token is shown once.
 */
export function CopyField({ label, value }: { label: string; value: string }) {
	const [copied, setCopied] = useState(false);
	const [failed, setFailed] = useState(false);
	const valueRef = useRef<HTMLElement>(null);

	const copy = async () => {
		if (!(await copyText(value))) {
			setFailed(true);
			const node = valueRef.current;
			if (node) window.getSelection()?.selectAllChildren(node);
			return;
		}
		setFailed(false);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<div className="space-y-1.5">
			<Label className="text-xs text-muted-foreground">{label}</Label>
			<div className="flex items-center gap-2">
				<code
					ref={valueRef}
					className="flex-1 select-all break-all rounded-md border border-border/50 bg-muted px-3 py-2 font-mono text-xs"
				>
					{value}
				</code>
				<Button
					variant="outline"
					size="icon"
					className="h-9 w-9 shrink-0"
					onClick={copy}
					aria-label={copied ? `${label} copied` : `Copy ${label}`}
				>
					{copied ? <Check className="h-3.5 w-3.5 text-foreground" /> : <Copy className="h-3.5 w-3.5" />}
				</Button>
			</div>
			{failed && (
				<p role="status" className="text-ui-xs text-destructive">
					{COPY_FAILED_MESSAGE}
				</p>
			)}
		</div>
	);
}
