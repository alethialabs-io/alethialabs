"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CopyButton } from "@repo/ui/copy-button";
import { Button } from "@repo/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@repo/ui/popover";
import { cn } from "@repo/ui/utils";
import { ArrowUpRight, Terminal } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

type OS = "mac" | "linux" | "windows";

/** Install command shown for each operating system. */
const COMMANDS: Record<OS, { label: string; command: string }> = {
	mac: { label: "macOS", command: "brew install alethia" },
	linux: { label: "Linux", command: "curl -fsSL https://get.alethialabs.io | sh" },
	windows: { label: "Windows", command: "irm https://get.alethialabs.io/install.ps1 | iex" },
};

/** Best-effort OS detection from the browser user agent. */
function detectOS(): OS {
	if (typeof navigator === "undefined") return "mac";
	const ua = navigator.userAgent.toLowerCase();
	if (ua.includes("win")) return "windows";
	if (ua.includes("linux") || ua.includes("android")) return "linux";
	return "mac";
}

/**
 * Header action that opens a popover with the one-line install command for the
 * detected OS (switchable) plus a link to the full installation docs.
 */
export function DownloadCliButton() {
	const [os, setOs] = useState<OS | null>(null);

	// Detect the OS on mount to keep SSR output stable.
	useEffect(() => setOs(detectOS()), []);

	const active = os ?? "mac";
	const { command } = COMMANDS[active];

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="h-9 gap-2 text-muted-foreground hover:text-foreground"
				>
					{/* `>_` prompt glyph (borderless) — mirrors the CLI itself. */}
					<Terminal className="h-4 w-4" />
					<span className="hidden sm:inline-flex items-center">
						Download alethia
						{/* Blinking terminal caret (reuses the alethia-blink keyframe). */}
						<span
							aria-hidden
							className="ml-0.5 inline-block h-4 w-[0.5ch] bg-current animate-[alethia-blink_1.1s_steps(1,end)_infinite] motion-reduce:animate-none"
						/>
					</span>
					<span className="sr-only sm:hidden">Download alethia CLI</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-96 p-0" align="end">
				<div className="border-b border-border/40 px-4 py-3">
					<p className="text-sm font-semibold text-foreground">Download Alethia</p>
					<p className="text-[11px] text-muted-foreground">
						Install the <code className="font-mono">alethia</code> CLI
					</p>
				</div>

				{/* OS selector */}
				<div className="flex items-center gap-1 px-3 pt-3">
					{(Object.keys(COMMANDS) as OS[]).map((key) => (
						<button
							key={key}
							type="button"
							onClick={() => setOs(key)}
							className={cn(
								"rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
								key === active
									? "bg-muted text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{COMMANDS[key].label}
						</button>
					))}
				</div>

				{/* Command */}
				<div className="px-3 py-3">
					<div className="flex items-start gap-2 rounded-md border border-border/50 bg-muted/40 px-3 py-2">
						<code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-foreground">
							<span className="mr-1 select-none text-muted-foreground">$</span>
							{command}
						</code>
						<CopyButton text={command} />
					</div>
				</div>

				{/* Docs link */}
				<div className="border-t border-border/40 px-3 py-2.5">
					<Link
						href="/docs"
						className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						Installation docs
						<ArrowUpRight className="h-3 w-3" />
					</Link>
				</div>
			</PopoverContent>
		</Popover>
	);
}
