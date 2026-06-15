"use client";

import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";

export function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(() => {
		navigator.clipboard.writeText(text);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}, [text]);

	return (
		<button
			onClick={handleCopy}
			className="text-muted-foreground hover:text-foreground transition-colors"
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
