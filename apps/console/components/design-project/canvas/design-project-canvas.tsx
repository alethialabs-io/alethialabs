"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { Plus, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	createProject,
	destroyProject,
	provisionProject,
	type CreateProjectInput,
} from "@/app/server/actions/projects";
import {
	applyStagedChanges,
	discardStagedChanges,
} from "@/app/server/actions/staged-changes";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { useAssistantStore } from "@/lib/stores/use-assistant-store";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { orgHref, projectHref } from "@/lib/routing";
import { projectFormSchema } from "@/lib/validations/project-form.schema";
import { SourceReposCard } from "../source-repos-card";
import { CanvasCommandPalette } from "./canvas-command-palette";
import { CanvasControls } from "./canvas-controls";
import { CanvasFlow } from "./canvas-flow";
import { CostPanel } from "./cost-panel";
import { PendingChangesBar } from "./pending-changes-bar";
import { graphToForm } from "./graph/graph-to-form";
import { NodeInspector } from "./node-inspector";
import { NodePalette } from "./node-palette";

interface DesignProjectCanvasProps {
	cloudIdentities: CloudIdentityOption[];
	/** Optional — only present while the legacy form view still exists. */
	onToggleForm?: () => void;
	/** Edit mode: persist + provision/destroy this live project's active environment.
	 * Absent in the create flow (Deploy creates a new project instead). */
	projectId?: string;
	envName?: string;
}

/** The canvas editor surface (inside its own ReactFlowProvider). */
export function DesignProjectCanvas(props: DesignProjectCanvasProps) {
	return (
		<ReactFlowProvider>
			<CanvasInner {...props} />
		</ReactFlowProvider>
	);
}

function CanvasInner({
	cloudIdentities,
	onToggleForm,
	projectId,
	envName,
}: DesignProjectCanvasProps) {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const { fitView } = useReactFlow();
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [cmdOpen, setCmdOpen] = useState(false);
	const openAssistant = useAssistantStore((s) => s.setOpen);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const [deploying, setDeploying] = useState(false);
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
		}
	}, [router, orgSlug]);

	/** Edit mode: persist the desired config to the live project, then provision the
	 * active environment. Falls back to create when there's no projectId. */
	const handleDeploy = useCallback(async () => {
		if (!projectId) return handleSave();
		const nodes = useCanvasStore.getState().nodes;
		const parsed = projectFormSchema.safeParse(graphToForm(nodes));
		if (!parsed.success) {
			const first = parsed.error.issues[0];
			toast.error(
				`Can't deploy: ${first?.path.join(".") || "project"} — ${first?.message}`,
			);
			return;
		}
		setDeploying(true);
		try {
			// Persist + provision the ACTIVE environment (config is environment-scoped).
			const environmentId = await resolveActiveEnvironmentId(projectId, envName);
			await applyStagedChanges(
				projectId,
				environmentId,
				parsed.data as unknown as CreateProjectInput,
			);
			await provisionProject(projectId, undefined, undefined, environmentId);
			useCanvasStore.getState().commitBaseline();
			toast.success("Deploy queued");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to deploy");
		} finally {
			setDeploying(false);
		}
	}, [projectId, envName, handleSave]);

	/** Edit mode: queue a DESTROY job for the active environment. */
	const handleDestroy = useCallback(async () => {
		if (!projectId) return;
		try {
			const environmentId = await resolveActiveEnvironmentId(projectId, envName);
			await destroyProject(projectId, environmentId);
			toast.success("Destroy queued");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to destroy");
		}
	}, [projectId, envName]);

	/** Edit mode: clear the active environment's staged changes (the Discard action). */
	const handleDiscardStaged = useCallback(async () => {
		if (!projectId) return;
		try {
			const environmentId = await resolveActiveEnvironmentId(projectId, envName);
			await discardStagedChanges(projectId, environmentId);
		} catch {
			// non-fatal — the canvas store already reverted; the durable rows just persist.
		}
	}, [projectId, envName]);

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
		<div className="relative h-full min-h-[480px] w-full">
			<div className="h-full">
				<CanvasFlow />
			</div>

			{/* Bottom-left: scanned source repos + monorepo services (hidden when none). */}
			<SourceReposCard />

			{/* Top-right: add a service + ask AI */}
			<div className="absolute right-3 top-3 z-10 flex items-center gap-2">
				<Button
					type="button"
					size="sm"
					className="h-8 text-xs"
					onClick={() => setPaletteOpen(true)}
				>
					<Plus className="mr-1 h-3.5 w-3.5" />
					Add
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-8 text-xs"
					onClick={() => openAssistant(true)}
				>
					<Sparkles className="mr-1 h-3.5 w-3.5" />
					AI
				</Button>
			</div>

			{/* Bottom-left: settings / zoom / fit / undo-redo / layers */}
			<CanvasControls />

			{/* Bottom-center: staged changes → Deploy / Discard / Destroy */}
			<PendingChangesBar
				onDeploy={projectId ? handleDeploy : handleSave}
				deploying={deploying}
				onDestroy={projectId ? handleDestroy : undefined}
				onDiscard={projectId ? () => void handleDiscardStaged() : undefined}
			/>

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
				onAskAi={() => openAssistant(true)}
			/>


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
