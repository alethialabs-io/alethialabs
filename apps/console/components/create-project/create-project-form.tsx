"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowRight, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { globalHref } from "@/lib/routing";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";
import { Button } from "@repo/ui/button";
import { Textarea } from "@repo/ui/textarea";

import { EXAMPLE_PROMPTS, examplePromptLabel } from "./example-prompts";

interface CreateProjectFormProps {
	orgSlug: string;
	/** Whether the member can invite others (drives the Collaborate pill vs an upgrade nudge). */
	canCollaborate: boolean;
}

/**
 * The top of `~/new`: the design agent's prompt. Describing the infrastructure hands it to the
 * agent surface as a seed; the one-screen form below (`create-project-screen.tsx`) is the other way
 * in, for a repository or a starting point.
 */
export function CreateProjectForm({ orgSlug, canCollaborate }: CreateProjectFormProps) {
	const { openUpgrade } = useUpgradeSheet();
	const [prompt, setPrompt] = useState("");
	const [launching, setLaunching] = useState(false);
	// `launching` holds the button pending until the agent surface is up. Once that surface CLOSES the
	// button must come back: without this it stayed spinning and disabled for the life of the page
	// (#4996). Adjusted during render, not in an effect, so no committed frame shows a closed modal
	// behind a still-pending button.
	const elenchOpen = useElenchStore((s) => s.open);
	if (launching && !elenchOpen) setLaunching(false);

	/** Hands the hero prompt to the global Elench surface as a seed and opens it in org context. */
	const onAskAgent = () => {
		const seed = prompt.trim();
		if (!seed) {
			toast.error("Describe what you want to run first.");
			return;
		}
		setLaunching(true);
		useElenchStore.getState().setSeedPrompt(seed);
		useElenchStore.getState().openModal({ kind: "org" });
	};

	return (
		<section className="space-y-5">
			<div className="flex items-center justify-between gap-4">
				<h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
					Provision the future.
				</h1>
				{canCollaborate ? (
					<Link
						href={globalHref(orgSlug, "settings/members")}
						className="inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<Users className="size-3.5" />
						Collaborate
					</Link>
				) : (
					<button
						type="button"
						onClick={openUpgrade}
						className="inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<Users className="size-3.5" />
						Collaborate
						<span className="rounded-full border border-border px-1.5 py-0.5 font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground">
							Pro
						</span>
					</button>
				)}
			</div>

			<div className="rounded-xl border border-border bg-card shadow-sm focus-within:border-ring">
				<div className="flex items-start gap-3 p-4 pb-2">
					<span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-border bg-foreground text-background">
						<Sparkles className="size-4" />
					</span>
					<Textarea
						aria-label="Describe your infrastructure"
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						rows={2}
						placeholder="Ask the design agent to design your infrastructure — e.g. an EKS cluster for an AI inference API, with a Postgres + pgvector store…"
						className="min-h-0 resize-none border-0 bg-transparent p-0 pt-1 text-ui-lg shadow-none focus-visible:ring-0"
						onKeyDown={(e) => {
							if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
								e.preventDefault();
								onAskAgent();
							}
						}}
					/>
				</div>
				<div className="flex items-center justify-between px-4 pb-3">
					<span className="font-mono text-ui-2xs text-muted-foreground">
						⌘ + ⏎
					</span>
					<Button
						type="button"
						size="icon"
						className="size-9"
						onClick={onAskAgent}
						pending={launching}
						aria-label={launching ? "Opening the design agent…" : "Design with the agent"}
					>
						<ArrowRight className="size-4" />
					</Button>
				</div>
			</div>

			<div className="flex flex-wrap gap-2">
				{EXAMPLE_PROMPTS.map((ex) => (
					<button
						key={ex}
						type="button"
						onClick={() => setPrompt(ex)}
						className="rounded-full border border-border bg-card px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						{examplePromptLabel(ex)}
					</button>
				))}
			</div>
		</section>
	);
}
