"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	BookOpen,
	Boxes,
	Building2,
	ChevronsUpDown,
	LayoutDashboard,
	Plus,
	Search,
	Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { ScrollArea } from "@repo/ui/scroll-area";
import type { ElenchWorkspace } from "@/components/agent/elench/use-elench-workspaces";
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
	/** The infra projects you can step into (the workspace switcher). */
	workspaces?: ElenchWorkspace[];
	/** The project workspace currently in scope; null = the general (org) assistant. */
	activeProjectId?: string | null;
	/** Step into a workspace (null = back to the general assistant). */
	onSelectWorkspace?: (projectId: string | null) => void;
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
 * (Today/Yesterday/Earlier). Grayscale/squared; hidden below `lg` (the design
 * sheds this pane on narrow viewports).
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
	workspaces,
	activeProjectId = null,
	onSelectWorkspace,
}: ThreadRailProps) {
	const [q, setQ] = useState("");
	const [wsOpen, setWsOpen] = useState(false);

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

	const activeWorkspace = workspaces?.find((w) => w.id === activeProjectId);

	return (
		<aside className="hidden w-[284px] flex-none flex-col border-r border-border bg-card lg:flex">
			{/* Workspace switcher. This used to be a LIST of nav rows, which meant that with zero
			    projects it collapsed to a lone "Chats · org" row that did nothing — a nav item
			    masquerading as state. It's a control: it names where you are, and changes it. */}
			{onSelectWorkspace && (
				<div className="border-b border-border p-2.5">
					<Popover open={wsOpen} onOpenChange={setWsOpen}>
						<PopoverTrigger asChild>
							<button
								type="button"
								data-testid="workspace-switcher"
								className="flex w-full items-center gap-2 border border-border bg-background px-2.5 py-2 text-left transition-colors hover:bg-muted"
							>
								{activeWorkspace ? (
									<Boxes className="h-3.5 w-3.5 flex-none text-muted-foreground" />
								) : (
									<Building2 className="h-3.5 w-3.5 flex-none text-muted-foreground" />
								)}
								<span className="min-w-0 flex-1">
									<span
										title={activeWorkspace?.name ?? "Organization"}
										className="block truncate text-[13px] text-foreground"
									>
										{activeWorkspace?.name ?? "Organization"}
									</span>
									<span className="vx-eyebrow block text-[9px] text-muted-foreground">
										{activeWorkspace ? "Project" : "All infrastructure"}
									</span>
								</span>
								<ChevronsUpDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
							</button>
						</PopoverTrigger>
						<PopoverContent
							align="start"
							className="w-[264px] rounded-none p-1"
						>
							<button
								type="button"
								onClick={() => {
									onSelectWorkspace(null);
									setWsOpen(false);
								}}
								className={cn(
									"flex w-full items-center gap-2 px-2.5 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-muted",
									activeProjectId === null && "bg-muted",
								)}
							>
								<Building2 className="h-3.5 w-3.5 flex-none text-muted-foreground" />
								Organization
							</button>
							{workspaces && workspaces.length > 0 && (
								<>
									<div className="vx-eyebrow px-2.5 pb-1 pt-2.5 text-[9px]">
										Projects
									</div>
									{workspaces.map((w) => (
										<button
											key={w.id}
											type="button"
											onClick={() => {
												onSelectWorkspace(w.id);
												setWsOpen(false);
											}}
											className={cn(
												"flex w-full items-center gap-2 px-2.5 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-muted",
												activeProjectId === w.id && "bg-muted",
											)}
										>
											<Boxes className="h-3.5 w-3.5 flex-none text-muted-foreground" />
											<span title={w.name} className="min-w-0 flex-1 truncate">
												{w.name}
											</span>
											{w.provider && (
												<span className="flex-none font-mono text-[9.5px] uppercase text-muted-foreground">
													{w.provider}
												</span>
											)}
										</button>
									))}
								</>
							)}
						</PopoverContent>
					</Popover>
				</div>
			)}

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
							"flex w-full items-center gap-2 rounded-none border border-transparent px-2.5 py-1.5 text-[13px] text-foreground transition-colors hover:bg-muted",
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
							"flex w-full items-center gap-2 rounded-none border border-transparent px-2.5 py-1.5 text-[13px] text-foreground transition-colors hover:bg-muted",
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
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="Search chats"
						className="h-7 rounded-none border-0 bg-transparent px-1.5 text-xs shadow-none focus-visible:ring-0"
					/>
				</div>
			</div>

			{/* Force Radix's `display:table` viewport wrapper to block — otherwise it grows to
			    max-content for a long unbroken title and the row's `w-full` never truncates. */}
			<ScrollArea className="flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
				<div className="px-2 pb-3.5">
					{groups.length === 0 && (
						<p className="px-2 py-6 text-center text-xs text-muted-foreground">
							No chats yet.
						</p>
					)}
					{groups.map((g) => (
						<div key={g.label}>
							<div className="vx-eyebrow px-2 pb-1.5 pt-3 text-[9px]">
								{g.label}
							</div>
							{g.items.map((t) => (
								<button
									key={t.id}
									type="button"
									data-testid="thread-rail-row"
									onClick={() => onSelect(t.id)}
									className={cn(
										"group flex w-full flex-col gap-0.5 border-l-2 border-transparent px-2.5 py-2 text-left transition-colors hover:bg-muted",
										activeId === t.id && "border-l-foreground bg-muted",
									)}
								>
									<span className="flex min-w-0 items-center justify-between gap-2">
										<span
											title={t.title}
											className="min-w-0 flex-1 truncate text-[12.5px] text-foreground"
										>
											{t.title}
										</span>
										<Trash2
											aria-label="Delete chat"
											onClick={(e) => {
												e.stopPropagation();
												onDelete(t.id);
											}}
											className="h-3 w-3 flex-none text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
										/>
									</span>
									<span className="flex items-center gap-1.5 font-mono text-[9.5px] text-muted-foreground">
										<span className="h-1 w-1 rounded-full bg-muted-foreground/60" />
										{relTime(new Date(t.updated_at))}
									</span>
								</button>
							))}
						</div>
					))}
				</div>
			</ScrollArea>
		</aside>
	);
}
