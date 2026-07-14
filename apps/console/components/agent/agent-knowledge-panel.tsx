"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BookOpen, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	getAgentContext,
	getProjectKnowledgePreview,
	upsertAgentContext,
} from "@/app/server/actions/agent-context";
import { Button } from "@repo/ui/button";
import { ScrollArea } from "@repo/ui/scroll-area";
import { Textarea } from "@repo/ui/textarea";

/** Server-side cap (upsertAgentContext) — mirrored here so the budget is visible while typing. */
const NOTES_LIMIT = 50_000;

/**
 * The Knowledge panel — the Claude-Projects idea, applied to an infra project. Edits the pinned
 * **custom instructions** and **knowledge** for the current scope; everything here rides the
 * system prompt of every chat in that scope. In a PROJECT chat it also shows a read-only preview
 * of the block Elench already derives from live state (identity, environments, recent jobs), so
 * it's obvious what you do *not* need to write down. In an ORG chat it edits the org-level row,
 * which is layered under every project's.
 */
export function AgentKnowledgePanel({
	projectId,
	onClose,
}: {
	/** null = the org-level row (the general assistant); set = that infra project's row. */
	projectId: string | null;
	onClose: () => void;
}) {
	const scope = projectId ? "Project" : "Organization";
	const [instructions, setInstructions] = useState("");
	const [notes, setNotes] = useState("");
	const [derived, setDerived] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
		"idle",
	);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void (async () => {
			const [ctx, preview] = await Promise.all([
				getAgentContext(projectId).catch(() => null),
				projectId
					? getProjectKnowledgePreview(projectId).catch(() => "")
					: Promise.resolve(""),
			]);
			if (cancelled) return;
			setInstructions(ctx?.instructions ?? "");
			setNotes(ctx?.notes ?? "");
			setDerived(preview);
			setLoading(false);
		})();
		return () => {
			cancelled = true;
		};
	}, [projectId]);

	const save = useCallback(async () => {
		setState("saving");
		try {
			await upsertAgentContext({ projectId, instructions, notes });
			setState("saved");
			setTimeout(() => setState("idle"), 1200);
		} catch {
			setState("error");
		}
	}, [projectId, instructions, notes]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex flex-none items-center gap-2 border-b border-border px-3 py-2.5">
				<BookOpen className="h-4 w-4 text-muted-foreground" />
				<div className="text-sm font-medium text-foreground">
					{scope} knowledge
				</div>
				<div className="ml-auto flex items-center gap-1.5">
					<span className="text-[11px] text-muted-foreground">
						{state === "saved"
							? "Saved."
							: state === "error"
								? "Save failed."
								: ""}
					</span>
					<Button
						size="sm"
						className="rounded-none"
						onClick={() => void save()}
						disabled={loading || state === "saving"}
					>
						{state === "saving" ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							"Save"
						)}
					</Button>
					<button
						type="button"
						aria-label="Close knowledge"
						onClick={onClose}
						className="flex size-8 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<X className="h-4 w-4" />
					</button>
				</div>
			</div>

			<ScrollArea className="min-h-0 flex-1">
				<div className="mx-auto max-w-[760px] space-y-6 p-5">
					{loading ? (
						<div className="py-16 text-center text-sm text-muted-foreground">
							Loading…
						</div>
					) : (
						<>
							<section className="space-y-1.5">
								<h2 className="text-[13px] font-medium text-foreground">
									Custom instructions
								</h2>
								<p className="text-xs text-muted-foreground">
									Rides every {projectId ? "chat in this project" : "org chat"}.
									e.g. “This is production — always require approval before an
									apply, and never suggest destroy.”
								</p>
								<Textarea
									value={instructions}
									onChange={(e) => setInstructions(e.target.value)}
									rows={5}
									placeholder="How should Elench behave here?"
									className="rounded-none text-sm"
								/>
							</section>

							<section className="space-y-1.5">
								<div className="flex items-baseline justify-between gap-2">
									<h2 className="text-[13px] font-medium text-foreground">
										Knowledge
									</h2>
									{/* Knowledge rides EVERY turn's system prompt, so its size is a real
									    cost — surface the budget, the way Claude shows project capacity. */}
									<span className="font-mono text-[10px] text-muted-foreground">
										{notes.length.toLocaleString()} / {NOTES_LIMIT.toLocaleString()}
									</span>
								</div>
								<p className="text-xs text-muted-foreground">
									Facts Elench can’t derive on its own — conventions, owners,
									runbooks, gotchas.
								</p>
								<Textarea
									value={notes}
									onChange={(e) => setNotes(e.target.value)}
									rows={8}
									placeholder="What should Elench always know?"
									className="rounded-none text-sm"
								/>
							</section>

							{projectId && (
								<section className="space-y-1.5">
									<h2 className="text-[13px] font-medium text-foreground">
										Already known (auto-derived)
									</h2>
									<p className="text-xs text-muted-foreground">
										Elench reads this from live state on every turn — you don’t
										need to write any of it down.
									</p>
									<pre className="overflow-x-auto whitespace-pre-wrap border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
										{derived?.trim() || "Nothing derived yet."}
									</pre>
								</section>
							)}
						</>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
