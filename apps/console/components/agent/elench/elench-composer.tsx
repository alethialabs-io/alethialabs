"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatStatus } from "ai";
import {
	ArrowUp,
	Boxes,
	Cpu,
	KeyRound,
	LayoutDashboard,
	type LucideIcon,
	Loader2,
	PlugZap,
	ScrollText,
	Server,
	Square,
	X,
} from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type {
	Mention,
	MentionResult,
	MentionType,
} from "@/lib/ai/mentions";
import { ScrollArea } from "@repo/ui/scroll-area";
import { cn } from "@repo/ui/utils";
import {
	ElenchAskMode,
	ElenchDeepReasoning,
	ElenchModelButton,
} from "./elench-controls";
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
	artifact: LayoutDashboard,
};

/**
 * Box metrics shared verbatim by the textarea and its highlight mirror, so the mirror's
 * styled glyphs sit exactly under the (transparent) textarea glyphs.
 */
const FIELD_METRICS =
	"px-3.5 py-3 text-sm leading-5 whitespace-pre-wrap break-words";

/**
 * Split the composer value into text + tagged-mention nodes for the highlight mirror: every
 * `@<label>` for a currently-tagged mention becomes a bold badge; the rest is plain text.
 * Earliest match wins; overlapping ranges are skipped. A trailing zero-width space keeps the
 * mirror's height in step with the textarea when the value ends on a newline.
 */
export function segmentMentions(value: string, mentions: Mention[]): ReactNode[] {
	const ranges: Array<{ start: number; end: number }> = [];
	for (const m of mentions) {
		const token = `@${m.label}`;
		let from = 0;
		for (;;) {
			const i = value.indexOf(token, from);
			if (i === -1) break;
			ranges.push({ start: i, end: i + token.length });
			from = i + token.length;
		}
	}
	ranges.sort((a, b) => a.start - b.start || b.end - a.end);

	const nodes: ReactNode[] = [];
	let cursor = 0;
	let key = 0;
	for (const r of ranges) {
		if (r.start < cursor) continue; // overlaps an earlier badge — skip
		if (r.start > cursor) nodes.push(value.slice(cursor, r.start));
		nodes.push(
			<span
				key={`m${key++}`}
				className="rounded-[3px] bg-muted px-0.5 font-semibold text-foreground"
			>
				{value.slice(r.start, r.end)}
			</span>,
		);
		cursor = r.end;
	}
	if (cursor < value.length) nodes.push(value.slice(cursor));
	nodes.push("\u200b"); // keep trailing-newline height
	return nodes;
}

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
	// The highlight mirror behind the textarea (kept scroll-aligned with it).
	const mirrorRef = useRef<HTMLDivElement>(null);
	const { results, loading } = useMentionSearch(anchor);
	const pending = status === "submitted" || status === "streaming";
	const popoverOpen = anchor !== null && (results.length > 0 || loading);
	const safeIndex = Math.min(index, Math.max(0, results.length - 1));

	// Keep the mirror scroll-aligned with the textarea after value changes (typing at the
	// bottom auto-scrolls the field; onScroll covers manual scrolls).
	useEffect(() => {
		if (mirrorRef.current && ref.current)
			mirrorRef.current.scrollTop = ref.current.scrollTop;
	}, [value]);

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

	/** Untag a resource — drop it from the reference list AND strip its `@token` from the text. */
	const removeMention = useCallback((m: Mention) => {
		setMentions((prev) =>
			prev.filter((p) => !(p.id === m.id && p.type === m.type)),
		);
		setValue((v) =>
			v.replaceAll(`@${m.label} `, "").replaceAll(`@${m.label}`, ""),
		);
	}, []);

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
					<ScrollArea className="max-h-64 [&_[data-slot=scroll-area-viewport]>div]:!block">
						<div className="py-1">
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
					</ScrollArea>
				</div>
			)}

			<div className="border border-border bg-background shadow-sm focus-within:ring-3 focus-within:ring-ring/25">
				{/* Highlight overlay: a mirror renders the styled text (tagged @tokens as bold
				    badges) UNDER a text-transparent textarea, so tags are visually distinct from
				    normal prose without a contenteditable rewrite. The two share FIELD_METRICS so
				    glyphs align; the textarea keeps the caret + all interaction. */}
				<div className="relative">
					<div
						ref={mirrorRef}
						aria-hidden
						className={cn(
							FIELD_METRICS,
							"pointer-events-none absolute inset-0 z-0 max-h-56 min-h-[72px] overflow-hidden text-foreground",
						)}
					>
						{segmentMentions(value, mentions)}
					</div>
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
						onScroll={(e) => {
							if (mirrorRef.current)
								mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
						}}
						className={cn(
							FIELD_METRICS,
							"field-sizing-content relative z-10 max-h-56 min-h-[72px] w-full resize-none bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted-foreground",
						)}
					/>
				</div>
				{/* Tagged-resource chips — an at-a-glance list with per-tag removal (× ), pairing
				    with the inline bold badges so it's clear what you've tagged and where. */}
				{mentions.length > 0 && (
					<div className="flex flex-wrap gap-1.5 px-2.5 pb-2">
						{mentions.map((m) => {
							const Icon = TYPE_ICON[m.type];
							return (
								<span
									key={`${m.type}:${m.id}`}
									className="inline-flex items-center gap-1.5 border border-border bg-muted px-2 py-0.5 text-xs text-foreground"
								>
									<Icon className="h-3 w-3 flex-none text-muted-foreground" />
									<span className="max-w-[160px] truncate font-medium">
										{m.label}
									</span>
									<button
										type="button"
										aria-label={`Remove ${m.label}`}
										onClick={() => removeMention(m)}
										className="flex-none text-muted-foreground transition-colors hover:text-foreground"
									>
										<X className="h-3 w-3" />
									</button>
								</span>
							);
						})}
					</div>
				)}
				<div className="flex items-center justify-between px-2.5 pb-2.5">
					<div className="flex items-center gap-1.5">
						<ElenchAskMode />
						{/* Max-only per-message Opus opt-in (org context); the control self-hides otherwise. */}
						{showModel && <ElenchDeepReasoning />}
					</div>
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
