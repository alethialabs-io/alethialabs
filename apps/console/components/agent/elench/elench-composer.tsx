"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatStatus } from "ai";
import {
	ArrowUp,
	Boxes,
	Cpu,
	KeyRound,
	type LucideIcon,
	Loader2,
	PlugZap,
	ScrollText,
	Server,
	Square,
} from "lucide-react";
import {
	type KeyboardEvent,
	useCallback,
	useRef,
	useState,
} from "react";
import type {
	Mention,
	MentionResult,
	MentionType,
} from "@/lib/ai/mentions";
import { cn } from "@repo/ui/utils";
import { ElenchAskMode, ElenchModelButton } from "./elench-controls";
import {
	detectMention,
	type MentionAnchor,
	useMentionSearch,
} from "./use-mentions";

const TYPE_ICON: Record<MentionType, LucideIcon> = {
	project: Boxes,
	cluster: Server,
	connector: PlugZap,
	job: ScrollText,
	runner: Cpu,
	identity: KeyRound,
};

/**
 * The Elench composer — a fully-controlled input so the `@mention` autocomplete has
 * the caret + value it needs. Typing `@` opens a resource picker (projects, clusters,
 * jobs, connectors, runners, identities); picking one inserts a token and records the
 * resolved reference, which rides with the sent message so Elench knows exactly what
 * each `@name` points to. Ask-mode pill on the left; model settings (org) + send on
 * the right. Used both in the modal hero and (via the shared chat) as the docked
 * composer, so the two are identical.
 */
export function ElenchComposer({
	onSend,
	onStop,
	placeholder = "Ask Elench, or type @ to tag a resource",
	showModel = false,
	status,
	autoFocus = false,
}: {
	onSend: (text: string, mentions: Mention[]) => void;
	/** Abort the in-flight stream — wired to the Square button while generating. */
	onStop?: () => void;
	placeholder?: string;
	/** Show the model picker (sliders) — org context only. */
	showModel?: boolean;
	status?: ChatStatus;
	autoFocus?: boolean;
}) {
	const [value, setValue] = useState("");
	const [mentions, setMentions] = useState<Mention[]>([]);
	const [anchor, setAnchor] = useState<MentionAnchor | null>(null);
	const [index, setIndex] = useState(0);
	const ref = useRef<HTMLTextAreaElement>(null);
	const { results, loading } = useMentionSearch(anchor);
	const pending = status === "submitted" || status === "streaming";
	const popoverOpen = anchor !== null && (results.length > 0 || loading);
	const safeIndex = Math.min(index, Math.max(0, results.length - 1));

	/** Re-evaluate whether the caret sits inside an `@mention` token. */
	const recompute = useCallback((v: string, caret: number) => {
		setAnchor(detectMention(v, caret));
	}, []);

	/** Replace the active `@query` with the picked resource + record the reference. */
	const pick = useCallback(
		(m: MentionResult) => {
			const el = ref.current;
			if (!anchor || !el) return;
			const caret = el.selectionStart ?? value.length;
			const before = value.slice(0, anchor.start);
			const after = value.slice(caret);
			const token = `@${m.label} `;
			setValue(before + token + after);
			setMentions((prev) =>
				prev.some((p) => p.id === m.id && p.type === m.type)
					? prev
					: [...prev, { id: m.id, type: m.type, label: m.label }],
			);
			setAnchor(null);
			requestAnimationFrame(() => {
				const pos = (before + token).length;
				el.focus();
				el.setSelectionRange(pos, pos);
			});
		},
		[anchor, value],
	);

	const submit = useCallback(() => {
		const text = value.trim();
		if (!text || pending) return;
		// Keep only the references still present in the text (backspaced ones drop).
		const used = mentions.filter((m) => value.includes(`@${m.label}`));
		onSend(text, used);
		setValue("");
		setMentions([]);
		setAnchor(null);
	}, [value, pending, mentions, onSend]);

	const onKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (popoverOpen) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setIndex((i) => Math.min(i + 1, results.length - 1));
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					setIndex((i) => Math.max(i - 1, 0));
					return;
				}
				if (e.key === "Enter" || e.key === "Tab") {
					if (results[safeIndex]) {
						e.preventDefault();
						pick(results[safeIndex]);
						return;
					}
				}
				if (e.key === "Escape") {
					e.preventDefault();
					setAnchor(null);
					return;
				}
			}
			if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
				e.preventDefault();
				submit();
			}
		},
		[popoverOpen, results, safeIndex, pick, submit],
	);

	return (
		<div className="relative">
			{popoverOpen && (
				<div className="absolute bottom-full left-0 z-50 mb-2 w-full border border-border bg-popover shadow-md">
					<div className="vx-eyebrow flex items-center gap-1.5 border-b border-border px-2.5 py-1.5 text-[9px]">
						Tag a resource
						{loading && <Loader2 className="h-3 w-3 animate-spin" />}
					</div>
					<div className="max-h-64 overflow-y-auto py-1">
						{results.length === 0 && !loading && (
							<div className="px-3 py-2 text-xs text-muted-foreground">
								No matching resources.
							</div>
						)}
						{results.map((m, i) => {
							const Icon = TYPE_ICON[m.type];
							return (
								<button
									key={`${m.type}:${m.id}`}
									type="button"
									onMouseEnter={() => setIndex(i)}
									onClick={() => pick(m)}
									className={cn(
										"flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
										i === safeIndex ? "bg-muted" : "hover:bg-muted",
									)}
								>
									<Icon className="h-4 w-4 flex-none text-muted-foreground" />
									<span className="min-w-0 flex-1">
										<span className="block truncate text-[13px] text-foreground">
											{m.label}
										</span>
										<span className="block truncate font-mono text-[10px] text-muted-foreground">
											{m.type} · {m.sublabel}
										</span>
									</span>
								</button>
							);
						})}
					</div>
				</div>
			)}

			<div className="border border-border bg-background shadow-sm focus-within:ring-3 focus-within:ring-ring/25">
				{/* biome-ignore lint/a11y/noAutofocus: opt-in via the modal hero only. */}
				<textarea
					ref={ref}
					value={value}
					// oxlint-disable-next-line eslint-plugin-jsx-a11y(no-autofocus)
					autoFocus={autoFocus}
					rows={1}
					placeholder={placeholder}
					onChange={(e) => {
						setValue(e.target.value);
						recompute(e.target.value, e.target.selectionStart ?? 0);
					}}
					onKeyDown={onKeyDown}
					onKeyUp={(e) =>
						recompute(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
					}
					onClick={(e) =>
						recompute(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
					}
					className="field-sizing-content max-h-40 min-h-[44px] w-full resize-none bg-transparent px-3.5 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
				/>
				<div className="flex items-center justify-between px-2.5 pb-2.5">
					<ElenchAskMode />
					<div className="flex items-center gap-1">
						{showModel && <ElenchModelButton />}
						<button
							type="button"
							aria-label={pending && onStop ? "Stop" : "Send"}
							onClick={pending ? onStop : submit}
							disabled={
								pending ? !onStop : value.trim().length === 0
							}
							className="flex size-8 items-center justify-center bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
						>
							{pending ? (
								<Square className="h-3.5 w-3.5" />
							) : (
								<ArrowUp className="h-4 w-4" />
							)}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
