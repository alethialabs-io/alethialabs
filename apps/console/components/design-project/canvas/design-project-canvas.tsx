"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { Keyboard, Loader2, Plus, Rocket, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { createProject, type CreateProjectInput } from "@/app/server/actions/projects";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { orgHref, projectHref } from "@/lib/routing";
import { projectFormSchema } from "@/lib/validations/project-form.schema";
import { AskAiSheet } from "./ai/ask-ai-sheet";
import { CanvasCommandPalette } from "./canvas-command-palette";
import { CanvasFlow } from "./canvas-flow";
import { CostPanel } from "./cost-panel";
import { graphToForm } from "./graph/graph-to-form";
import { NodeInspector } from "./node-inspector";
import { NodePalette } from "./node-palette";

interface DesignProjectCanvasProps {
	cloudIdentities: CloudIdentityOption[];
	onToggleForm: () => void;
}

/** The canvas editor surface (inside its own ReactFlowProvider). */
export function DesignProjectCanvas(props: DesignProjectCanvasProps) {
	return (
		<ReactFlowProvider>
			<CanvasInner {...props} />
		</ReactFlowProvider>
	);
}

function CanvasInner({ cloudIdentities, onToggleForm }: DesignProjectCanvasProps) {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const { fitView } = useReactFlow();
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [cmdOpen, setCmdOpen] = useState(false);
	const [askAiOpen, setAskAiOpen] = useState(false);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const selectedIds = useCanvasStore((s) => s.selectedIds);
	const openInspector = useCanvasStore((s) => s.openInspector);
	const undo = useCanvasStore((s) => s.undo);
	const redo = useCanvasStore((s) => s.redo);
	const duplicateNodes = useCanvasStore((s) => s.duplicateNodes);

	const handleSave = useCallback(async () => {
		const nodes = useCanvasStore.getState().nodes;
		const parsed = projectFormSchema.safeParse(graphToForm(nodes));
		if (!parsed.success) {
			const first = parsed.error.issues[0];
			toast.error(
				`Can't save: ${first?.path.join(".") || "project"} — ${first?.message}`,
			);
			return;
		}
		setSaving(true);
		try {
			const { project } = await createProject(
				parsed.data as unknown as CreateProjectInput,
			);
			toast.success("Project created!");
			useCanvasStore.getState().reset();
			router.push(
				project.slug ? projectHref(orgSlug, project.slug) : orgHref(orgSlug),
			);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to create project");
		} finally {
			setSaving(false);
		}
	}, [router, orgSlug]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			if (mod && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setCmdOpen((o) => !o);
				return;
			}
			if (mod && e.key.toLowerCase() === "s") {
				e.preventDefault();
				void handleSave();
				return;
			}
			if (mod && e.key.toLowerCase() === "z") {
				e.preventDefault();
				if (e.shiftKey) redo();
				else undo();
				return;
			}
			if (mod && e.key.toLowerCase() === "d") {
				e.preventDefault();
				if (selectedIds.length) duplicateNodes(selectedIds);
				return;
			}
			const t = e.target as HTMLElement | null;
			const typing =
				!!t &&
				(t.tagName === "INPUT" ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable);
			if (typing) return;
			if (e.key === "a") {
				setPaletteOpen(true);
				return;
			}
			if (e.key === "?") {
				setShortcutsOpen((o) => !o);
				return;
			}
			if (e.key === "Enter" && selectedIds[0]) openInspector(selectedIds[0]);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [handleSave, selectedIds, openInspector, undo, redo, duplicateNodes]);

	return (
		<div className="relative h-[calc(100vh-13rem)] min-h-[520px] w-full border border-border">
			<div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between border-b border-border bg-background/80 px-3 py-2 backdrop-blur">
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-8 text-xs"
						onClick={() => setPaletteOpen(true)}
					>
						<Plus className="mr-1 h-3.5 w-3.5" />
						Add component
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-8 text-xs"
						onClick={() => setAskAiOpen(true)}
					>
						<Sparkles className="mr-1 h-3.5 w-3.5" />
						Ask AI
					</Button>
					<span className="font-mono text-[11px] text-muted-foreground">
						⌘K
					</span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-8 px-2 text-xs"
						onClick={() => setShortcutsOpen(true)}
						aria-label="Keyboard shortcuts"
					>
						<Keyboard className="h-3.5 w-3.5" />
					</Button>
				</div>
				<Button
					type="button"
					size="sm"
					className="h-8 text-xs"
					onClick={handleSave}
					disabled={saving}
				>
					{saving ? (
						<>
							<Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
							Creating…
						</>
					) : (
						<>
							<Rocket className="mr-1 h-3.5 w-3.5" />
							Create project
						</>
					)}
				</Button>
			</div>

			<div className="h-full pt-[44px]">
				<CanvasFlow />
			</div>

			<div className="absolute bottom-3 right-3 z-10">
				<CostPanel />
			</div>

			<NodePalette
				open={paletteOpen}
				onOpenChange={setPaletteOpen}
				identities={cloudIdentities}
			/>
			<NodeInspector identities={cloudIdentities} />
			<CanvasCommandPalette
				open={cmdOpen}
				onOpenChange={setCmdOpen}
				onSave={handleSave}
				onToggleView={onToggleForm}
				onFitView={() => fitView({ padding: 0.3 })}
				onAskAi={() => setAskAiOpen(true)}
			/>

			<AskAiSheet open={askAiOpen} onOpenChange={setAskAiOpen} />

			<Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle className="text-base">Keyboard shortcuts</DialogTitle>
					</DialogHeader>
					<div className="space-y-1.5">
						{SHORTCUTS.map((s) => (
							<div
								key={s.label}
								className="flex items-center justify-between text-sm"
							>
								<span className="text-muted-foreground">{s.label}</span>
								<kbd className="border border-border px-1.5 py-0.5 font-mono text-[11px]">
									{s.keys}
								</kbd>
							</div>
						))}
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

const SHORTCUTS: { label: string; keys: string }[] = [
	{ label: "Command palette", keys: "⌘K" },
	{ label: "Add component", keys: "A" },
	{ label: "Open inspector", keys: "Enter" },
	{ label: "Duplicate selection", keys: "⌘D" },
	{ label: "Delete selection", keys: "Del" },
	{ label: "Undo / Redo", keys: "⌘Z / ⇧⌘Z" },
	{ label: "Save project", keys: "⌘S" },
	{ label: "Shortcuts", keys: "?" },
];
