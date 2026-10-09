"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BookOpen, LayoutDashboard, Plus, Search, Trash2 } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { Input } from "@repo/ui/input";
import { ScrollArea } from "@repo/ui/scroll-area";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import {
	type ConversationDraftFacts,
	type UnsentConversation,
	unsentNoteText,
} from "@/components/agent/elench/use-elench-threads";
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
	/**
	 * The Unsent group (ADR 0001 decision 3): conversations of this scope holding words that were
	 * never sent, shown above the threads. Selecting one calls `onSelect` with its conversation id.
	 */
	unsent?: readonly UnsentConversation[];
	/**
	 * Counts a conversation's drafts for the delete confirm (§6.3). Without it, the confirm names
	 * no count.
	 */
	countDrafts?: (id: string) => Promise<ConversationDraftFacts | null>;
}


/** The delete confirm's count, while it is asked for and once it is answered. */
interface DeleteCount {
	id: string;
	done: boolean;
	facts: ConversationDraftFacts | null;
}

const DELETE_BASE =
	"This permanently deletes the conversation and everything in it — the transcript, its widgets and its approvals. This cannot be undone.";

/** "1 unsent message" / "2 unsent messages". */
function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * The delete confirm's description (§6.3): what the delete removes, then the drafts of the
 * conversation it removes with it — how many, in how many organizations, and whether one is being
 * sent right now — once the count has answered.
 */
function deleteDescription(count: DeleteCount | null): string {
	if (count === null) return DELETE_BASE;
	if (!count.done) return `${DELETE_BASE} Counting its unsent messages…`;
	const f = count.facts;
	if (f === null) return `${DELETE_BASE} Its unsent messages could not be counted; any it has are deleted with it.`;
	const parts = [DELETE_BASE];
	if (f.count > 0)
		parts.push(
			`It also deletes ${plural(f.count, "unsent message", "unsent messages")} of this conversation, in ${plural(f.orgs, "organization", "organizations")}.`,
		);
	if (f.sending) parts.push("A message in this conversation is being sent right now.");
	return parts.join(" ");
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
 * Thread sidebar — New chat, search, the Unsent group (conversations holding words that were never
 * sent, ADR 0001 decision 3), and the owner's threads grouped by recency (Today/Yesterday/Earlier). Grayscale/squared; hidden below `lg` unless the caller passes a
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
	unsent = [],
	countDrafts,
}: ThreadRailProps) {
	const [q, setQ] = useState("");
	// The thread a delete has been REQUESTED for. A chat carries its whole transcript and there is
	// no undo, and the trigger is a small icon (hover-revealed where a pointer can hover) a hand's
	// width from the row you meant to open — so the click asks first (#4280).
	const [pendingDelete, setPendingDelete] = useState<AgentThread | null>(null);
	const [deleteCount, setDeleteCount] = useState<DeleteCount | null>(null);
	const unsentHeadingId = useId();

	/** Opens the delete confirm for `t`, and asks for its draft count (§6.3) while it is open. */
	const requestDelete = (t: AgentThread) => {
		setPendingDelete(t);
		if (countDrafts === undefined) return setDeleteCount(null);
		setDeleteCount({ id: t.id, done: false, facts: null });
		void countDrafts(t.id).then(
			(facts) => setDeleteCount((cur) => (cur?.id === t.id ? { id: t.id, done: true, facts } : cur)),
			() => setDeleteCount((cur) => (cur?.id === t.id ? { id: t.id, done: true, facts: null } : cur)),
		);
	};

	const shownUnsent = useMemo(() => {
		const needle = q.trim().toLowerCase();
		return needle ? unsent.filter((u) => u.label.toLowerCase().includes(needle)) : unsent;
	}, [unsent, q]);

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
					{shownUnsent.length > 0 && (
						<div role="group" aria-labelledby={unsentHeadingId}>
							<div
								id={unsentHeadingId}
								className="vx-eyebrow flex items-center justify-between px-2 pb-1.5 pt-3 text-ui-3xs"
							>
								<span>Unsent</span>
								<span className="font-mono">{shownUnsent.length}</span>
							</div>
							{shownUnsent.map((u) => (
								<button
									key={u.conversationId}
									type="button"
									data-testid="thread-rail-unsent-row"
									aria-current={u.active ? "true" : undefined}
									onClick={() => onSelect(u.conversationId)}
									className={cn(
										"flex w-full flex-col gap-0.5 border-l-2 border-transparent px-2.5 py-2 text-left transition-colors hover:bg-muted",
										u.active && "border-l-foreground bg-muted",
									)}
								>
									<span title={u.label} className="min-w-0 truncate text-ui-sm text-foreground">
										{u.label}
									</span>
									<span className="font-mono text-ui-3xs text-muted-foreground">
										{unsentNoteText(u.note)}
									</span>
								</button>
							))}
						</div>
					)}
					{groups.length === 0 && shownUnsent.length === 0 && (
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
										onClick={() => requestDelete(t)}
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
					if (!o) {
						setPendingDelete(null);
						setDeleteCount(null);
					}
				}}
				title={`Delete ${pendingDelete?.title ?? "this chat"}?`}
				description={deleteDescription(deleteCount)}
				confirmLabel="Delete chat"
				onConfirm={() => {
					if (pendingDelete) onDelete(pendingDelete.id);
					setPendingDelete(null);
					setDeleteCount(null);
				}}
			/>
		</aside>
	);
}
