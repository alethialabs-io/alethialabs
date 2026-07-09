"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Check,
	ChevronsRight,
	Pencil,
	SlidersHorizontal,
	Sparkles,
} from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/tooltip";
import { AI_MODELS } from "@/lib/config/ai";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { cn } from "@repo/ui/utils";
import { useAiTier } from "./use-ai-tier";

/**
 * The composer Ask-mode pill + popover. "Ask before editing" → `mode: "ask"`
 * (review & approve each change); "Automatically edit" → `mode: "act"` (allow edits
 * for this conversation). Drives the shared store's mode (the org agent route reads
 * it to gate the mutation tools).
 */
export function ElenchAskMode() {
	const mode = useElenchStore((s) => s.mode);
	const setMode = useElenchStore((s) => s.setMode);
	const isAsk = mode === "ask";

	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground transition-colors hover:bg-muted"
				>
					{isAsk ? (
						<Pencil className="h-3.5 w-3.5 text-muted-foreground" />
					) : (
						<ChevronsRight className="h-3.5 w-3.5 text-muted-foreground" />
					)}
					{isAsk ? "Ask" : "Auto"}
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				side="top"
				className="w-[270px] rounded-none p-1.5"
			>
				<button
					type="button"
					onClick={() => setMode("ask")}
					className={cn(
						"flex w-full items-start gap-2.5 rounded-none px-2.5 py-2 text-left transition-colors hover:bg-muted",
						isAsk && "bg-muted",
					)}
				>
					<Pencil className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
					<span className="flex-1">
						<span className="block text-[13px] font-medium text-foreground">
							Ask before editing
						</span>
						<span className="block text-xs text-muted-foreground">
							Review and approve each change
						</span>
					</span>
					{isAsk && (
						<Check className="mt-0.5 h-3.5 w-3.5 flex-none text-foreground" />
					)}
				</button>
				<button
					type="button"
					onClick={() => setMode("act")}
					className={cn(
						"flex w-full items-start gap-2.5 rounded-none px-2.5 py-2 text-left transition-colors hover:bg-muted",
						!isAsk && "bg-muted",
					)}
				>
					<ChevronsRight className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
					<span className="flex-1">
						<span className="block text-[13px] font-medium text-foreground">
							Automatically edit
						</span>
						<span className="block text-xs text-muted-foreground">
							Always allow edits for this conversation
						</span>
					</span>
					{!isAsk && (
						<Check className="mt-0.5 h-3.5 w-3.5 flex-none text-foreground" />
					)}
				</button>
			</PopoverContent>
		</Popover>
	);
}

/**
 * The per-message "Deep reasoning (Opus)" toggle. Renders ONLY on the `ai_max` tier — Max
 * runs the Sonnet advisor by default (like Plus) and opts into the pricier Opus advisor per
 * message via this pill, whose state rides the request as `deepReasoning`. Hidden on every
 * other tier (and while the tier is still resolving), so it's a Max-only affordance.
 */
export function ElenchDeepReasoning() {
	const tier = useAiTier();
	const deepReasoning = useElenchStore((s) => s.deepReasoning);
	const setDeepReasoning = useElenchStore((s) => s.setDeepReasoning);

	if (tier !== "ai_max") return null;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-pressed={deepReasoning}
					onClick={() => setDeepReasoning(!deepReasoning)}
					className={cn(
						"inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
						deepReasoning
							? "border-primary bg-primary text-primary-foreground"
							: "border-border bg-background text-foreground hover:bg-muted",
					)}
				>
					<Sparkles
						className={cn(
							"h-3.5 w-3.5",
							deepReasoning ? "text-primary-foreground" : "text-muted-foreground",
						)}
					/>
					Deep reasoning
				</button>
			</TooltipTrigger>
			<TooltipContent side="top" className="max-w-[240px] text-xs">
				Run this message on the Opus model — slower, deeper planning. A Max feature; off by
				default (Max uses the Sonnet advisor).
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * The composer settings control — the sliders button that opens the model picker.
 * Org context only (the project route has no user-selectable model).
 */
export function ElenchModelButton() {
	const model = useElenchStore((s) => s.model);
	const setModel = useElenchStore((s) => s.setModel);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label="Model settings"
				className="inline-flex size-7 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			>
				<SlidersHorizontal className="h-4 w-4" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" side="top" className="rounded-none">
				{AI_MODELS.map((m) => (
					<DropdownMenuItem
						key={m.id}
						onSelect={() => setModel(m.id)}
						className="gap-6 rounded-none text-xs"
					>
						<div className="flex flex-col">
							<span>{m.name}</span>
							<span className="font-mono text-[9px] text-muted-foreground">
								{m.provider}
							</span>
						</div>
						{m.id === model && <Check className="ml-auto h-3.5 w-3.5" />}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
