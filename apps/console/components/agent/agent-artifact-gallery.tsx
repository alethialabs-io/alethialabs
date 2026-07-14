"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LayoutDashboard, Plus, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { deleteArtifact, listArtifacts } from "@/app/server/actions/artifacts";
import type { AgentArtifact } from "@/lib/db/schema";
import { Button } from "@repo/ui/button";
import { ScrollArea } from "@repo/ui/scroll-area";

/**
 * The Artifacts gallery — the modal's main region when the rail's "Artifacts" nav is
 * active. Lists the org's saved artifacts (dashboards + widgets) as cards; opening one
 * materializes it onto a chat's grid (`onOpenArtifact`, which ensures a thread). "New
 * artifact" is just a fresh chat with the grid open — an artifact is a chat you decide to
 * save, so there's no separate authoring UI. `onClose` returns to the conversation.
 */
export function AgentArtifactGallery({
	onOpenArtifact,
	onNewArtifact,
	onClose,
}: {
	onOpenArtifact: (id: string, name: string) => void;
	onNewArtifact: () => void;
	onClose: () => void;
}) {
	const [items, setItems] = useState<AgentArtifact[] | null>(null);

	const load = useCallback(() => {
		setItems(null);
		void listArtifacts()
			.then(setItems)
			.catch(() => setItems([]));
	}, []);

	useEffect(() => load(), [load]);

	/** Delete an artifact, then optimistically drop it from the list. */
	const remove = useCallback(async (id: string) => {
		try {
			await deleteArtifact(id);
			setItems((prev) => prev?.filter((a) => a.id !== id) ?? prev);
		} catch {
			// Non-fatal — the next load reconciles.
		}
	}, []);

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* Gallery top bar — mirrors the conversation top bar's height/rhythm. */}
			<div className="flex flex-none items-center gap-2 border-b border-border px-3 py-2.5">
				<div className="text-sm font-medium text-foreground">Artifacts</div>
				<span className="font-mono text-[11px] text-muted-foreground">
					{items ? items.length : ""}
				</span>
				<div className="ml-auto flex items-center gap-1.5">
					<Button
						size="sm"
						variant="outline"
						className="gap-1.5 rounded-none"
						onClick={onNewArtifact}
					>
						<Plus className="h-3.5 w-3.5" />
						New artifact
					</Button>
					<button
						type="button"
						aria-label="Close artifacts"
						onClick={onClose}
						className="flex size-8 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<X className="h-4 w-4" />
					</button>
				</div>
			</div>

			<ScrollArea className="min-h-0 flex-1">
				<div className="p-5">
				{items === null ? (
					<div className="py-16 text-center text-sm text-muted-foreground">
						Loading artifacts…
					</div>
				) : items.length === 0 ? (
					<div className="mx-auto flex max-w-[420px] flex-col items-center gap-3 border border-dashed border-border py-16 text-center">
						<LayoutDashboard className="h-5 w-5 text-muted-foreground" />
						<div className="text-[15px] font-semibold text-foreground">
							No artifacts yet
						</div>
						<p className="text-[13px] text-muted-foreground">
							Start a chat, ask Elench to build a dashboard, then save it — it lands
							here for any conversation to reopen.
						</p>
						<Button
							size="sm"
							className="mt-1 gap-1.5 rounded-none"
							onClick={onNewArtifact}
						>
							<Plus className="h-3.5 w-3.5" />
							New artifact
						</Button>
					</div>
				) : (
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{items.map((a) => (
							<div
								key={a.id}
								className="group/card relative flex flex-col justify-between border border-border bg-background p-4 transition-colors hover:bg-muted"
							>
								<button
									type="button"
									onClick={() => onOpenArtifact(a.id, a.name)}
									className="flex flex-1 flex-col items-start gap-3 text-left"
								>
									<span className="flex size-9 flex-none items-center justify-center border border-border text-muted-foreground">
										{a.kind === "dashboard" ? (
											<LayoutDashboard className="h-4 w-4" />
										) : (
											<Square className="h-4 w-4" />
										)}
									</span>
									<span
										title={a.name}
										className="line-clamp-2 min-w-0 break-words text-[14px] font-medium text-foreground"
									>
										{a.name}
									</span>
								</button>
								<div className="mt-4 flex items-center justify-between">
									<span className="font-mono text-[10px] uppercase text-muted-foreground">
										{a.kind} · {a.spec.widgets.length}{" "}
										{a.spec.widgets.length === 1 ? "widget" : "widgets"}
									</span>
									<button
										type="button"
										aria-label={`Delete ${a.name}`}
										onClick={() => void remove(a.id)}
										className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/card:opacity-100"
									>
										<Trash2 className="h-3.5 w-3.5" />
									</button>
								</div>
							</div>
						))}
					</div>
				)}
				</div>
			</ScrollArea>
		</div>
	);
}
