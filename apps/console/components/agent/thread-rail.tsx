"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BookOpen, LayoutDashboard, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { Input } from "@repo/ui/input";
import { ScrollArea } from "@repo/ui/scroll-area";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import type { AgentThread } from "@/lib/db/schema";
import { cn } from "@repo/ui/utils";

interface ThreadRailProps {
	threads: AgentThread[];
	activeId: string | null;
	onSelect: (id: string) => void;
	onNew: () => void;
	onDelete: (id: string) => void;
	/** Open the Artifacts gallery (modal only). When set, an "Artifacts" nav item shows. */
	onOpenArtifacts?: () => void;
	/** True while the Artifacts gallery is the active view (highlights the nav item). */
	artifactsActive?: boolean;
	/** Open the Knowledge panel (modal only). When set, a "Knowledge" nav item shows. */
	onOpenKnowledge?: () => void;
	/** True while the Knowledge panel is the active view. */
	knowledgeActive?: boolean;
	/**
	 * Merged over the rail's own classes. The rail is `hidden` below `lg` by default — the docked
	 * column it was built for has no room there — so a caller that hosts it somewhere that DOES fit
	 * a narrow screen (the modal's sheet, #5650) passes `flex` here to show it at every width.
	 */
	className?: string;
}

const DAY = 86_400_000;
const BUCKETS = ["Today", "Yesterday", "Earlier"] as const;
type Bucket = (typeof BUCKETS)[number];

/** Midnight (local) of a date, as epoch ms. */
function startOfDay(d: Date): number {
	const x = new Date(d);
	x.setHours(0, 0, 0, 0);
	return x.getTime();
}

function bucketOf(updatedAt: Date, todayStart: number): Bucket {
	const t = startOfDay(updatedAt);
	if (t >= todayStart) return "Today";
	if (t >= todayStart - DAY) return "Yesterday";
	return "Earlier";
}

function relTime(d: Date): string {
	const m = Math.floor((Date.now() - d.getTime()) / 60_000);
	if (m < 1) return "now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/**
 * Thread sidebar — New chat, search, and the owner's threads grouped by recency
 * (Today/Yesterday/Earlier). Grayscale/squared; hidden below `lg` unless the caller passes a
 * `className` that shows it — the modal hosts it in a sheet there (#5650).
 */
export function ThreadRail({
	threads,
	activeId,
	onSelect,
	onNew,
	onDelete,
	onOpenArtifacts,
	artifactsActive = false,
	onOpenKnowledge,
	knowledgeActive = false,
	className,
}: ThreadRailProps) {
	const [q, setQ] = useState("");
	// The thread a delete has been REQUESTED for. A chat carries its whole transcript and there is
	// no undo, and the trigger is a small icon (hover-revealed where a pointer can hover) a hand's
	// width from the row you meant to open — so the click asks first (#4280).
	const [pendingDelete, setPendingDelete] = useState<AgentThread | null>(null);

	const groups = useMemo(() => {
		const todayStart = startOfDay(new Date());
		const needle = q.trim().toLowerCase();
		const map: Record<Bucket, AgentThread[]> = {
			Today: [],
			Yesterday: [],
			Earlier: [],
		};
		for (const t of threads) {
			if (needle && !t.title.toLowerCase().includes(needle)) continue;
			map[bucketOf(new Date(t.updated_at), todayStart)].push(t);
		}
		return BUCKETS.filter((b) => map[b].length > 0).map((b) => ({
			label: b,
			items: map[b],
		}));
	}, [threads, q]);

	return (
		<aside
			className={cn(
				"hidden w-[284px] flex-none flex-col border-r border-border bg-card lg:flex",
				className,
			)}
		>
			<div className="flex flex-col gap-1.5 p-2.5">
				<Button
					variant="outline"
					className="w-full justify-start gap-2 rounded-none"
					onClick={onNew}
				>
					<Plus className="h-3.5 w-3.5" />
					New chat
				</Button>
				{onOpenArtifacts && (
					<button
						type="button"
						onClick={onOpenArtifacts}
						className={cn(
							"flex w-full items-center gap-2 rounded-none border border-transparent px-2.5 py-1.5 text-ui-md text-foreground transition-colors hover:bg-muted",
							artifactsActive && "border-border bg-muted",
						)}
					>
						<LayoutDashboard className="h-3.5 w-3.5 text-muted-foreground" />
						Artifacts
					</button>
				)}
				{onOpenKnowledge && (
					<button
						type="button"
						onClick={onOpenKnowledge}
						className={cn(
							"flex w-full items-center gap-2 rounded-none border border-transparent px-2.5 py-1.5 text-ui-md text-foreground transition-colors hover:bg-muted",
							knowledgeActive && "border-border bg-muted",
						)}
					>
						<BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
						Knowledge
					</button>
				)}
			</div>

			{/* Hairline field with real padding — it used to be a bare `bg-muted` strip whose input
			    was `px-0`, so the text sat flush against the icon. */}
			<div className="px-2.5 pb-2.5">
				<div className="flex items-center gap-2 border border-border bg-background px-2.5 py-1 focus-within:ring-3 focus-within:ring-ring/25">
					<Search className="h-3.5 w-3.5 flex-none text-muted-foreground" />
					<Input
						aria-label="Search chats"
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="Search chats"
						className="h-7 rounded-none border-0 bg-transparent px-1.5 text-xs shadow-none focus-visible:ring-0"
					/>
				</div>
			</div>

			<ScrollArea className="flex-1">
				<div className="px-2 pb-3.5">
					{groups.length === 0 && (
						/* The rail is a 240px column, so the shared state's page-sized padding is
						   tuned down the same way the artifact panel's is — the structure and the
						   words stay shared, only the scale is local. */
						<EmptyState
							className="gap-2 p-6 md:p-6 [&_[data-slot=empty-title]]:text-xs [&_[data-slot=empty-title]]:font-normal [&_[data-slot=empty-title]]:text-muted-foreground"
							title="No chats yet."
						/>
					)}
					{groups.map((g) => (
						<div key={g.label}>
							<div className="vx-eyebrow px-2 pb-1.5 pt-3 text-ui-3xs">
								{g.label}
							</div>
							{g.items.map((t) => (
								/* The row is a button and the delete is a SIBLING of it, not a child.
								   The trash used to be a bare `<svg onClick>` inside the row button —
								   it had no role, so nothing keyboard-driven (and no `getByRole`)
								   could reach it, and a real <button> nested inside another is
								   invalid. The wrapper carries `group` so the hover reveal is
								   unchanged, and the row button keeps its testid and its classes. */
								<div key={t.id} className="group relative">
									<button
										type="button"
										data-testid="thread-rail-row"
										onClick={() => onSelect(t.id)}
										className={cn(
											"flex w-full flex-col gap-0.5 border-l-2 border-transparent px-2.5 py-2 text-left transition-colors hover:bg-muted",
											activeId === t.id && "border-l-foreground bg-muted",
										)}
									>
										<span className="flex min-w-0 items-center gap-2 pr-5">
											<span
												title={t.title}
												className="min-w-0 flex-1 truncate text-ui-sm text-foreground"
											>
												{t.title}
											</span>
										</span>
										<span className="flex items-center gap-1.5 font-mono text-ui-3xs text-muted-foreground">
											<span className="h-1 w-1 rounded-full bg-muted-foreground/60" />
											{relTime(new Date(t.updated_at))}
										</span>
									</button>
									{/* The name carries the TITLE, and the noun is not decoration. N rows
									    all named "Delete chat" are N indistinguishable buttons to a
									    screen reader, and — now that this is a real <button> with a
									    role — the destructive-action audit's `/Delete/i` prefix match
									    resolved the Artifacts and Knowledge entries to THIS control,
									    because the rail is mounted before <main> and `.first()` takes
									    document order. The three surfaces now say which thing they
									    delete: "Delete chat …", "Delete artifact …", "Delete
									    document …". */}
									{/* Hidden until wanted — but "wanted" is said three ways, and hover is only
									    one of them. A pointer that can hover reveals it on the row
									    (`group-hover`, which Tailwind v4 already scopes to
									    `@media (hover: hover)`); a keyboard reveals it on focus, on the
									    control itself or anywhere in its row (`group-focus-within`); and a
									    device that CANNOT hover — a phone, where #5655 made this rail
									    reachable as a sheet — shows it outright (`@media (hover: none)`),
									    because there is no gesture there that would ever reveal it (#5657).
									    `(hover: none)` reads only the PRIMARY pointer, so a touchscreen
									    laptop (mouse primary) would still hide it from a tap; any coarse
									    pointer shows it too (`@media (any-pointer: coarse)`).
									    The ink is a named tier at full strength; no alpha. */}
									<button
										type="button"
										aria-label={`Delete chat ${t.title}`}
										onClick={() => setPendingDelete(t)}
										className="absolute right-2 top-2 flex size-4 items-center justify-center text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 [@media(any-pointer:coarse)]:opacity-100"
									>
										<Trash2 className="h-3 w-3" />
									</button>
								</div>
							))}
						</div>
					))}
				</div>
			</ScrollArea>

			<ConfirmDialog
				open={pendingDelete !== null}
				onOpenChange={(o) => {
					if (!o) setPendingDelete(null);
				}}
				title={`Delete ${pendingDelete?.title ?? "this chat"}?`}
				description="This permanently deletes the conversation and everything in it — the transcript, its widgets and its approvals. This cannot be undone."
				confirmLabel="Delete chat"
				onConfirm={() => {
					if (pendingDelete) onDelete(pendingDelete.id);
					setPendingDelete(null);
				}}
			/>
		</aside>
	);
}
