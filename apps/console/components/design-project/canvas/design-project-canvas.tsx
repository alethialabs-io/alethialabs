"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { motion } from "motion/react";
import { Plus, Settings } from "lucide-react";
import { cn } from "@repo/ui/utils";
import { track } from "@/lib/analytics/track";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	createProject,
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
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { orgHref, projectHref } from "@/lib/routing";
import { projectFormSchema } from "@/lib/validations/project-form.schema";
import { SourceReposCard } from "../source-repos-card";
import { CanvasCommandPalette } from "./canvas-command-palette";
import { CanvasControls } from "./canvas-controls";
import { CanvasDock, useDockState } from "./canvas-dock";
import { CanvasFlow } from "./canvas-flow";
import { PendingChangesBar } from "./pending-changes-bar";
import { graphToForm } from "./graph/graph-to-form";
import { NodePalette } from "./node-palette";

interface DesignProjectCanvasProps {
	cloudIdentities: CloudIdentityOption[];
	/** Optional — only present while the legacy form view still exists. */
	onToggleForm?: () => void;
	/** Edit mode: persist + provision/destroy this live project's active environment.
	 * Absent in the create flow (Deploy creates a new project instead). */
	projectId?: string;
	environmentId?: string;
	/** When true the docked panel (inspector + assistant) is owned by the project shell, so the
	 * board renders alone. When false (the standalone create flow) the board renders its own dock. */
	dockInShell?: boolean;
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
	environmentId,
	dockInShell,
}: DesignProjectCanvasProps) {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const { fitView } = useReactFlow();
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [cmdOpen, setCmdOpen] = useState(false);
	const openPanel = useElenchStore((s) => s.openPanel);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const [deploying, setDeploying] = useState(false);
	const selectedIds = useCanvasStore((s) => s.selectedIds);
	const openInspector = useCanvasStore((s) => s.openInspector);
	const undo = useCanvasStore((s) => s.undo);
	const redo = useCanvasStore((s) => s.redo);
	const duplicateNodes = useCanvasStore((s) => s.duplicateNodes);

	// The standalone (create-flow) dock — the project shell owns it otherwise (`dockInShell`).
	const dock = useDockState(true);

	/** Open the Elench assistant as a docked panel for this project (or org pre-creation). */
	const openAssistantExclusive = useCallback(() => {
		openPanel(projectId ? { kind: "project", projectId } : { kind: "org" });
	}, [openPanel, projectId]);

	/** Open a node's inspector (the assistant is a separate overlay now). */
	const openInspectorExclusive = useCallback(
		(id: string) => {
			openInspector(id);
		},
		[openInspector],
	);

	// Shortcut hints render with OS-correct modifiers (⌘ on macOS, Ctrl elsewhere). The key
	// handlers themselves stay OS-agnostic (`metaKey || ctrlKey`) — only the labels differ.
	const shortcuts = useMemo(() => {
		const isMac =
			typeof navigator !== "undefined" &&
			/Mac|iP(hone|ad|od)/.test(navigator.platform);
		return buildShortcuts(isMac);
	}, []);

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
			// Persist + provision the ACTIVE environment (config is environment-scoped). Re-resolve
			// through the server so a stale/absent id still lands on the project's default env.
			const activeEnvId = await resolveActiveEnvironmentId(
				projectId,
				environmentId,
			);
			await applyStagedChanges(
				projectId,
				activeEnvId,
				parsed.data as unknown as CreateProjectInput,
			);
			await provisionProject(projectId, undefined, undefined, activeEnvId);
			track("deploy_queued", { environmentId: activeEnvId });
			useCanvasStore.getState().commitBaseline();
			toast.success("Deploy queued");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to deploy");
		} finally {
			setDeploying(false);
		}
	}, [projectId, environmentId, handleSave]);

	/** Edit mode: clear the active environment's staged changes (the Discard action). */
	const handleDiscardStaged = useCallback(async () => {
		if (!projectId) return;
		try {
			const activeEnvId = await resolveActiveEnvironmentId(
				projectId,
				environmentId,
			);
			await discardStagedChanges(projectId, activeEnvId);
		} catch {
			// non-fatal — the canvas store already reverted; the durable rows just persist.
		}
	}, [projectId, environmentId]);

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
			if (mod && e.key.toLowerCase() === "i") {
				e.preventDefault();
				if (projectId) openAssistantExclusive();
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
			if (e.key === "Enter" && selectedIds[0])
				openInspectorExclusive(selectedIds[0]);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [
		handleSave,
		selectedIds,
		openInspectorExclusive,
		openAssistantExclusive,
		projectId,
		undo,
		redo,
		duplicateNodes,
	]);

	const boardContent = (
		<>
			{/* Keyed by the active environment so switching envs (picker / Shift+Tab) crossfades
			    the canvas instead of snapping to the new env's design. */}
			<motion.div
				key={environmentId ?? "default"}
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				transition={{ duration: 0.15 }}
				className="h-full"
			>
				<CanvasFlow />
			</motion.div>

			{/* Bottom-left: scanned source repos + monorepo services (hidden when none). */}
			<SourceReposCard />

			{/* Top-right: project settings + add a service. (Ask AI lives in the app shell now.) */}
			<div className="absolute right-3 top-3 z-10 flex items-center gap-2">
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="h-8 w-8"
					onClick={() => openInspectorExclusive(PROJECT_NODE_ID)}
					aria-label="Project settings"
					title="Project settings"
				>
					<Settings className="h-4 w-4" />
				</Button>
				<Button
					type="button"
					size="sm"
					className="h-8 text-xs"
					onClick={() => setPaletteOpen(true)}
				>
					<Plus className="mr-1 h-3.5 w-3.5" />
					Add
				</Button>
			</div>

			{/* Bottom-left: settings / zoom / fit / undo-redo / layers */}
			<CanvasControls />

			{/* Bottom-center: staged changes → Deploy / Discard (Destroy now lives in Project settings) */}
			<PendingChangesBar
				onDeploy={projectId ? handleDeploy : handleSave}
				deploying={deploying}
				onDiscard={projectId ? () => void handleDiscardStaged() : undefined}
			/>

			<NodePalette
				open={paletteOpen}
				onOpenChange={setPaletteOpen}
				identities={cloudIdentities}
			/>
			<CanvasCommandPalette
				open={cmdOpen}
				onOpenChange={setCmdOpen}
				onSave={handleSave}
				onToggleView={onToggleForm}
				onFitView={() => fitView({ padding: 0.3 })}
				onAskAi={openAssistantExclusive}
			/>

			<Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle className="text-base">Keyboard shortcuts</DialogTitle>
					</DialogHeader>
					<div className="space-y-1.5">
						{shortcuts.map((s) => (
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
		</>
	);

	// In the project shell the dock (inspector + persistent assistant) is rendered one level up, so
	// the board renders alone. The standalone create flow renders its own dock beside the board.
	if (dockInShell)
		return (
			<div className="relative h-full min-h-[480px] w-full">{boardContent}</div>
		);

	return (
		<div className="flex h-full min-h-[480px] w-full">
			<div
				className={cn(
					"relative min-h-[480px] min-w-0 flex-1",
					dock && "border-r border-border",
				)}
			>
				{boardContent}
			</div>
			<CanvasDock
				dock={dock}
				projectId={projectId}
				identities={cloudIdentities}
			/>
		</div>
	);
}

/** The shortcut hint rows, with OS-correct modifier glyphs (⌘ on macOS, `Ctrl` elsewhere). */
function buildShortcuts(isMac: boolean): { label: string; keys: string }[] {
	const mod = isMac ? "⌘" : "Ctrl";
	const j = isMac ? "" : "+"; // "⌘K" on macOS vs "Ctrl+K" elsewhere
	return [
		{ label: "Command palette", keys: `${mod}${j}K` },
		{ label: "Add component", keys: "A" },
		{ label: "Ask AI", keys: `${mod}${j}I` },
		{ label: "Open inspector", keys: "Enter" },
		{ label: "Duplicate selection", keys: `${mod}${j}D` },
		{ label: "Delete selection", keys: "Del" },
		{
			label: "Undo / Redo",
			keys: isMac ? "⌘Z / ⇧⌘Z" : "Ctrl+Z / Ctrl+Shift+Z",
		},
		{ label: "Switch environment", keys: isMac ? "⇧⇥" : "Shift+Tab" },
		{ label: "Save project", keys: `${mod}${j}S` },
		{ label: "Shortcuts", keys: "?" },
	];
}
