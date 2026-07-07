"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { ScrollArea } from "@repo/ui/scroll-area";
import type { AgentThread } from "@/lib/db/schema";
import { cn } from "@repo/ui/utils";

interface ThreadRailProps {
	threads: AgentThread[];
	activeId: string | null;
	onSelect: (id: string) => void;
	onNew: () => void;
	onDelete: (id: string) => void;
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
}: ThreadRailProps) {
	const [q, setQ] = useState("");

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
		<aside className="hidden w-[284px] flex-none flex-col border-r border-border bg-card lg:flex">
			<div className="p-3.5 pb-2.5">
				<Button
					variant="outline"
					className="w-full justify-start gap-2 rounded-none"
					onClick={onNew}
				>
					<Plus className="h-3.5 w-3.5" />
					New chat
				</Button>
			</div>

			<div className="px-3.5 pb-2">
				<div className="flex items-center gap-2 bg-muted px-2.5">
					<Search className="h-3.5 w-3.5 flex-none text-muted-foreground" />
					<Input
						value={q}
						onChange={(e) => setQ(e.target.value)}
						placeholder="Search chats"
						className="h-8 rounded-none border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
					/>
				</div>
			</div>

			<ScrollArea className="flex-1">
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
									onClick={() => onSelect(t.id)}
									className={cn(
										"group flex w-full flex-col gap-0.5 border-l-2 border-transparent px-2.5 py-2 text-left transition-colors hover:bg-muted",
										activeId === t.id && "border-l-foreground bg-muted",
									)}
								>
									<span className="flex items-center justify-between gap-2">
										<span className="truncate text-[12.5px] text-foreground">
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
