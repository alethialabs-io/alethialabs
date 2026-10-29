"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { motion } from "motion/react";
import { Plus } from "lucide-react";
import { cn } from "@repo/ui/utils";
import { track } from "@/lib/analytics/track";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	createProjectFromDesignAction,
	deployDesignAction,
	destroyEnvironmentAction,
	discardStagedDesignAction,
	saveDesignAction,
} from "@/app/server/actions/canvas-writes";
import type { AddonMarketItem } from "@/app/server/actions/addons";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { ByoChartDialog } from "@/components/design-project/byo/byo-chart-dialog";
import { ByoChartCanvasProvider } from "@/components/design-project/byo/byo-chart-canvas-context";
import { ByoIacDialog } from "@/components/design-project/byo/byo-iac-dialog";
import { IacSourceCanvasProvider } from "@/components/design-project/byo/iac-source-canvas-context";
import { IacNode } from "@/components/design-project/byo/iac-node";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { useAddonsQuery } from "@/lib/query/use-addons-query";
import { arrangeBoard } from "@/lib/canvas/arrange";
import { draftScope } from "@/lib/canvas/design-revision";
import { environmentStatusInput } from "@/lib/query/use-environment-status-query";
import { DESTROY_HOLD_KEY } from "@/lib/query/topics";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { orpc } from "@/lib/rpc/client";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { orgHref, projectHref } from "@/lib/routing";
import { projectFormSchema } from "@/lib/validations/project-form.schema";
import { SourceReposCard } from "../source-repos-card";
import { ActivityStatusLine } from "./cards/activity-status-line";
import { CanvasMoreMenu } from "./canvas-more-menu";
import type { DestroyOptions } from "./cards/destroy-tree-view";
import { CostChip } from "./cost-chip";
import { RunMenu } from "./run-menu";
import { CanvasCommandPalette } from "./canvas-command-palette";
import { useHasDrawnNodes } from "./use-has-drawn-nodes";
import {
	CanvasContextMenu,
	useCanvasContextMenu,
} from "./canvas-context-menu";
import { CanvasControls } from "./canvas-controls";
import { CanvasFlow, CanvasInteractionContext } from "./canvas-flow";
import { useCardDeepLink } from "./cards/card-param";
import { isRailOpen, WorkspaceRail } from "./cards/workspace-rail";
import { useDropPosition } from "./use-drop-position";
import { PendingChangesBar } from "./pending-changes-bar";
import { buildShortcuts } from "./shortcuts";
import { graphToForm } from "./graph/graph-to-form";
import { NodePalette } from "./node-palette";
import { BoardGuide, useDesignIsEmpty } from "./board-guide";
import { BoardPreview } from "./board-preview";
import { EnvironmentStatusNotice } from "./environment-status-notice";
import { EnvironmentStatusScope } from "./environment-status-scope";

interface DesignProjectCanvasProps {
	cloudIdentities: CloudIdentityOption[];
	/** Optional — only present while the legacy form view still exists. */
	onToggleForm?: () => void;
	/** Edit mode: persist + provision/destroy this live project's active environment.
	 * Absent in the create flow (Deploy creates a new project instead). */
	projectId?: string;
	environmentId?: string;
	/** Edit mode: the project's name — what a cascading destroy asks the user to type. */
	projectName?: string;
	/**
	 * Inert. The workspace rail renders inside the canvas on every route now; the prop stays only
	 * because the workbench and the Architecture page still pass it, and both are other lanes'
	 * files. Delete it with them.
	 */
	dockInShell?: boolean;
	/** Whether bring-your-own Helm charts are enabled on this instance (server flag). Gates the
	 * ⌘K "Sources" entry. Server actions enforce the real gate regardless. */
	byoHelmEnabled?: boolean;
	/** Whether BYO chart-workload DESCRIBE is enabled (server flag). Gates loading + rendering the
	 * described `project_chart_workloads` child nodes. Server actions enforce the real gate. */
	byoDescribeEnabled?: boolean;
	/** Whether bring-your-own IaC is enabled on this instance (server flag). Gates the ⌘K "Bring
	 * your own IaC" entry + the module's source card. Server actions enforce the real gate. */
	byoIacEnabled?: boolean;
}

/** The canvas editor surface (inside its own ReactFlowProvider and environment-status read). */
export function DesignProjectCanvas(props: DesignProjectCanvasProps) {
	return (
		<ReactFlowProvider>
			<EnvironmentStatusScope projectId={props.projectId} environmentId={props.environmentId}>
				<CanvasInner {...props} />
			</EnvironmentStatusScope>
		</ReactFlowProvider>
	);
}

function CanvasInner({
	cloudIdentities,
	onToggleForm,
	projectId,
	environmentId,
	projectName,
	byoHelmEnabled,
	byoDescribeEnabled,
	byoIacEnabled,
}: DesignProjectCanvasProps) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const searchParams = useSearchParams();
	const orgSlug = useActiveOrgSlug();
	const { fitView } = useReactFlow();
	const hasDrawnNodes = useHasDrawnNodes();
	// W5 click-to-place — computed here (inside the ReactFlowProvider) and handed to the palettes so
	// they don't each need the React Flow context (and stay testable without a provider).
	const dropPosition = useDropPosition();
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [cmdOpen, setCmdOpen] = useState(false);
	// Traversal mode (Excalidraw/Miro): the sticky hand tool (toolbar / `H`) and the transient
	// Space-to-pan. Held here — the top of the canvas tree — and shared with the board + controls via
	// CanvasInteractionContext (not the canvas store: this is view interaction, not design state).
	const [handTool, setHandTool] = useState(false);
	const [spaceHeld, setSpaceHeld] = useState(false);
	const interaction = useMemo(
		() => ({ handTool, setHandTool, spaceHeld }),
		[handTool, spaceHeld],
	);
	// Right-click. Held here for the same reason as the hand tool: which menu is showing is view
	// interaction, not design state. The three handlers go to the board (React Flow raises the
	// events); the menu itself renders below, next to the palettes.
	const contextMenu = useCanvasContextMenu();
	// Cluster add-ons for this environment (edit mode only) — browsed from the Add palette,
	// configured in a card on the workspace rail. Add-ons live on the canvas now (the standalone
	// page was retired).
	const addonsQuery = useAddonsQuery(projectId, environmentId);
	const [byoDialogOpen, setByoDialogOpen] = useState(false);
	const [iacDialogOpen, setIacDialogOpen] = useState(false);
	// The environment's attached BYO IaC source (edit mode + flag on) — the module's provenance:
	// repo · ref · pinned commit · scan verdict, with detach/rescan. Its RESOURCES are separate: they
	// are external nodes on the board (see the setIacNodes effect below), because a customer who
	// brought an entire infrastructure should see an architecture, not one card over a dimmed graph.
	const openCard = useCanvasStore((s) => s.openCard);
	const closeCard = useCanvasStore((s) => s.closeCard);
	const card = useCanvasStore((s) => s.card);
	const openConfigureAddon = useCallback(
		(item: AddonMarketItem) => openCard({ kind: "addon", itemId: item.id }),
		[openCard],
	);
	const openPanel = useElenchStore((s) => s.openPanel);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const selectedIds = useCanvasStore((s) => s.selectedIds);
	const openInspector = useCanvasStore((s) => s.openInspector);
	const undo = useCanvasStore((s) => s.undo);
	const redo = useCanvasStore((s) => s.redo);
	const duplicateNodes = useCanvasStore((s) => s.duplicateNodes);
	const removeNodes = useCanvasStore((s) => s.removeNodes);
	const setChartNodes = useCanvasStore((s) => s.setChartNodes);
	const setChartWorkloadNodes = useCanvasStore((s) => s.setChartWorkloadNodes);
	const setAddonNodes = useCanvasStore((s) => s.setAddonNodes);
	const setIacNodes = useCanvasStore((s) => s.setIacNodes);
	const setIacOutputs = useCanvasStore((s) => s.setIacOutputs);
	// The seed the store holds. Out-of-band layers (charts, add-ons, IaC cards) are re-applied
	// whenever it changes: a scope switch RESETS the store, and these reads are prefetched, so their
	// data can land before the seed does — without this they would be applied and then wiped.
	const seed = useCanvasStore((s) => s.seed);
	// Whether the store holds THIS environment's design yet. Until it does, the board shows the
	// skeleton over itself rather than an empty canvas (F009).
	const seeded = seed?.scope === draftScope(projectId, environmentId);
	const designEmpty = useDesignIsEmpty();
	// The environment's server truth (read once by `EnvironmentStatusScope`, above) — it also carries
	// the BYO IaC module and the architecture derived from it.
	const envStatus = useEnvironmentStatus();
	// A deep link can name the card to open (`?card=activity|env-settings|node:<id>|addon:<id>`)
	// — the Jobs page and the assistant link here. Both ordering hazards it has to survive are
	// documented on the hook.
	useCardDeepLink(searchParams, openCard);

	// ── The board's writes, on the mutation contract (ADR 0005 §D4, #6119) ──────────────────────
	//
	// Each is one `useActionMutation`: pending while in flight (the triggers bind it, and each handler
	// below drops a press that races one in flight), every refusal routed by kind, a confirmation
	// only where the outcome is not already on screen, and every key that shows the changed data
	// invalidated when it settles. A deploy, a destroy and a save all move the environment's status
	// and its job history; a destroy also moves the environments list and what a held destroy waits on.
	const environmentKeys = [orpc.canvas.environmentStatus.key(), orpc.canvas.environmentJobs.key()];
	const saveDesign = useActionMutation(saveDesignAction, {
		invalidates: [orpc.canvas.environmentStatus.key()],
		successMessage: "Design saved",
		// The pending-changes bar diffs against the baseline; committing it is what clears the bar.
		onSuccess: () => useCanvasStore.getState().commitBaseline(),
	});
	const deployDesign = useActionMutation(deployDesignAction, {
		invalidates: environmentKeys,
		successMessage: "Deploy queued",
		onSuccess: (data) => {
			track("deploy_queued", { environmentId: data.environmentId });
			useCanvasStore.getState().commitBaseline();
		},
	});
	const discardStaged = useActionMutation(discardStagedDesignAction, {
		invalidates: [orpc.canvas.environmentStatus.key()],
	});
	const destroyEnv = useActionMutation(destroyEnvironmentAction, {
		invalidates: [
			...environmentKeys,
			[...DESTROY_HOLD_KEY],
			orpc.environments.key(),
			orpc.workspace.environments.key(),
		],
		successMessage: (data) =>
			data.queued > 1 ? `Destroy queued for ${data.queued} environments` : "Destroy queued",
	});
	const createFromDesign = useActionMutation(createProjectFromDesignAction, {
		invalidates: [orpc.workspace.projects.key()],
		successMessage: "Project created!",
		onSuccess: (data) => {
			useCanvasStore.getState().reset();
			router.push(data.slug ? projectHref(orgSlug, data.slug) : orgHref(orgSlug));
		},
	});
	const deploying = deployDesign.isPending || createFromDesign.isPending;
	const saving = saveDesign.isPending;

	/**
	 * Edit mode: read the active environment's destroy tree (#5261) — the `canvas.destroyTree` GET
	 * procedure, always fresh: the Environment settings card reads it BEFORE it offers to destroy, so
	 * the tenants it names are seen first, and an answer from before a tenant moved would be a wrong one.
	 */
	const loadDestroyTree = useCallback(async () => {
		if (!projectId) return [];
		const { tree } = await queryClient.fetchQuery({
			...orpc.canvas.destroyTree.queryOptions({
				input: environmentStatusInput(projectId, environmentId),
			}),
			staleTime: 0,
		});
		return tree;
	}, [queryClient, projectId, environmentId]);

	const destroyIsPending = destroyEnv.isPending;
	const mutateDestroy = destroyEnv.mutateAsync;
	/**
	 * Edit mode: tear down the environment the destroy tree named — with `cascade`, every tenant on
	 * its cluster too. The id comes from the tree the dialog showed, never from the board's own
	 * (possibly stale) environment, so what is destroyed is what was confirmed.
	 */
	const handleDestroyEnvironment = useCallback(
		async ({ cascade, environmentId: target }: DestroyOptions) => {
			if (!projectId || destroyIsPending) return;
			try {
				await mutateDestroy({ projectId, environmentId: target, cascade });
			} catch {
				// Already said by the mutation: a refusal ("destroy the children first") in one toast.
			}
		},
		[projectId, destroyIsPending, mutateDestroy],
	);

	const destroyEnvironment = useMemo(
		() =>
			projectId
				? {
						projectName: projectName ?? null,
						loadTree: loadDestroyTree,
						destroy: handleDestroyEnvironment,
					}
				: undefined,
		[projectId, projectName, loadDestroyTree, handleDestroyEnvironment],
	);

	// The reads below are the board's out-of-band layers. Each is a GET procedure the Architecture
	// page prefetched under this same input, so the first paint carries them; a change to any of
	// them arrives as a hint on the org's change stream and invalidates the key (lib/query/topics.ts).
	const envInput = environmentStatusInput(projectId ?? "", environmentId);

	// BYO chart nodes are out-of-band: they come from `canvas.byoCharts`, never from the design.
	// Only in edit mode with the feature on.
	const byoChartsQuery = useQuery({
		...orpc.canvas.byoCharts.queryOptions({ input: envInput }),
		enabled: !!projectId && !!byoHelmEnabled,
	});
	// Described chart workloads (W5 Path A) are out-of-band too: children of their chart nodes. Only
	// in edit mode with the describe flag on; a failed read leaves the workloads absent (the honest
	// empty state — a chart with no described children yet).
	const chartWorkloadsQuery = useQuery({
		...orpc.canvas.chartWorkloads.queryOptions({ input: envInput }),
		enabled: !!projectId && !!byoDescribeEnabled,
	});
	const byoCharts = byoChartsQuery.data?.charts;
	const chartWorkloads = chartWorkloadsQuery.data?.workloads;
	useEffect(() => {
		if (byoCharts) setChartNodes(byoCharts);
	}, [byoCharts, setChartNodes, seed]);
	useEffect(() => {
		if (chartWorkloads) setChartWorkloadNodes(chartWorkloads);
	}, [chartWorkloads, setChartWorkloadNodes, seed]);

	// Installed marketplace add-ons become NODES. They were configured in a sheet and explicitly not
	// graph nodes, so an installed Grafana was invisible on the architecture — even though it's an
	// ArgoCD Application whose health and sync are already in the database. Out-of-band like charts:
	// never written by graphToForm, never part of the Deploy diff.
	useEffect(() => {
		const installed = (addonsQuery.data?.items ?? []).filter(
			(a) => a.install?.enabled,
		);
		setAddonNodes(
			installed.map((a) => ({
				id: a.id,
				name: a.name,
				version: a.version,
				namespace: a.namespace,
				status: a.install?.status,
				health: a.install?.health ?? null,
				sync: a.install?.sync ?? null,
			})),
		);
	}, [addonsQuery.data, setAddonNodes, seed]);

	// The BYO IaC module's RESOURCES, as read-only external cards. They ride on the environment
	// status — the one round-trip the board already makes — so a card and its status, cost and drift
	// can never disagree about which plan they came from. Empty for a template env, which clears
	// them. (getEnvironmentComponentStatus derives the groups: the last successful PLAN's exact,
	// expanded addresses when there is one, else the IAC_SCAN's declared skeleton.)
	useEffect(() => {
		setIacNodes(envStatus.iac?.groups ?? []);
		// The module's output names ride the same round-trip as its cards, so the bind sheet's
		// facet→output picker (#823) has choices whenever there are BYO-IaC cards to bind to.
		setIacOutputs(envStatus.iac?.outputs ?? []);
	}, [envStatus.iac, setIacNodes, setIacOutputs, seed]);

	// BYO IaC source is single-per-env: the module's provenance card, from `canvas.iacSource`. Only in
	// edit mode with the feature on; attach / detach / rescan invalidate it (their mutations' keys).
	const iacSourceQuery = useQuery({
		...orpc.canvas.iacSource.queryOptions({ input: envInput }),
		enabled: !!projectId && !!byoIacEnabled,
	});
	const iacSource = iacSourceQuery.data?.source ?? null;

	// While an ENABLED IaC source governs this env, the component graph isn't the source of truth —
	// so there is nothing to add to it: the Add palette and ⌘K component-add are disabled.
	//
	// This reads the SERVER's answer (the environment status), not the flag-gated `iacSource` fetch.
	// Deriving it from `iacSource` meant an instance with the BYO-IaC flag off never learned the env
	// was governed — so it happily offered to add components to an environment whose design is inert
	// and will never be applied, while the module's own cards sat right there on the board. Whether
	// the env IS governed is a fact about the environment; the flag only gates ATTACHING a new one.
	const iacGoverned = envStatus.iac !== null;

	// Repo-first on-ramp: the new-project "Bring your own Helm chart" path lands here with
	// ?attachChart=1 → auto-open the attach flow, then strip the param so a refresh doesn't re-open.
	useEffect(() => {
		if (
			projectId &&
			byoHelmEnabled &&
			searchParams.get("attachChart") === "1"
		) {
			setByoDialogOpen(true);
			router.replace(window.location.pathname);
		}
	}, [projectId, byoHelmEnabled, searchParams, router]);

	// Repo-first on-ramp: the new-project "Bring your own IaC" path lands here with
	// ?attachIac=1 → auto-open the attach flow, then strip the param so a refresh doesn't re-open.
	useEffect(() => {
		if (projectId && byoIacEnabled && searchParams.get("attachIac") === "1") {
			setIacDialogOpen(true);
			router.replace(window.location.pathname);
		}
	}, [projectId, byoIacEnabled, searchParams, router]);

	/** Open the Elench assistant as a docked panel for this project (or org pre-creation). */
	const openAssistantExclusive = useCallback(() => {
		openPanel(
			projectId
				? { kind: "project", projectId, environmentId: environmentId ?? null }
				: { kind: "org" },
		);
	}, [openPanel, projectId, environmentId]);

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
		return buildShortcuts(isMac, !projectId);
	}, [projectId]);

	const createIsPending = createFromDesign.isPending;
	const mutateCreate = createFromDesign.mutate;
	/**
	 * Create flow ONLY: turn the canvas into a new project.
	 *
	 * There is deliberately no edit-mode counterpart. On a live project the pending-changes bar is
	 * the one path changes take — it diffs against `baseline`, and only `commitBaseline()` clears
	 * it, so a second "save" that persisted without committing would leave the bar reporting changes
	 * that are already written. The guard below is defence in depth: before it existed, ⌘S on an
	 * existing project ran this handler and FORKED it into a duplicate.
	 */
	const handleSave = useCallback(() => {
		if (projectId || createIsPending) return;
		const nodes = useCanvasStore.getState().nodes;
		const parsed = projectFormSchema.safeParse(graphToForm(nodes));
		if (!parsed.success) {
			const first = parsed.error.issues[0];
			toast.error(
				`Can't save: ${first?.path.join(".") || "project"} — ${first?.message}`,
			);
			return;
		}
		mutateCreate({ design: parsed.data });
	}, [projectId, createIsPending, mutateCreate]);

	const saveIsPending = saveDesign.isPending;
	const mutateSave = saveDesign.mutate;
	/**
	 * Edit mode: persist the desired config to the live project WITHOUT provisioning. There was no
	 * such path — the pending-changes bar's only verb was Deploy, so a design you were not ready to
	 * provision had nowhere to go but the tab's sessionStorage draft. `saveDesignAction` writes the
	 * live design tables and the durable staged rows; `commitBaseline` clears the bar.
	 */
	const handleSaveDesign = useCallback(() => {
		if (!projectId || saveIsPending) return;
		const nodes = useCanvasStore.getState().nodes;
		const parsed = projectFormSchema.safeParse(graphToForm(nodes));
		if (!parsed.success) {
			const first = parsed.error.issues[0];
			toast.error(
				`Can't save: ${first?.path.join(".") || "project"} — ${first?.message}`,
			);
			return;
		}
		mutateSave({ projectId, environmentId: environmentId ?? null, design: parsed.data });
	}, [projectId, environmentId, saveIsPending, mutateSave]);

	const deployIsPending = deployDesign.isPending;
	const mutateDeploy = deployDesign.mutate;
	/**
	 * Edit mode: persist the desired config to the live project, then provision the active
	 * environment (config is environment-scoped; the server re-resolves the environment, so a stale
	 * or absent id still lands on the project's default). Falls back to create when there's no
	 * projectId. A refused deploy leaves the design saved and the baseline uncommitted: nothing
	 * deployed, and the refusal's sentence says how to fix it (#5445).
	 */
	const handleDeploy = useCallback(() => {
		if (!projectId) {
			handleSave();
			return;
		}
		if (deployIsPending) return;
		const nodes = useCanvasStore.getState().nodes;
		const parsed = projectFormSchema.safeParse(graphToForm(nodes));
		if (!parsed.success) {
			const first = parsed.error.issues[0];
			toast.error(
				`Can't deploy: ${first?.path.join(".") || "project"} — ${first?.message}`,
			);
			return;
		}
		mutateDeploy({ projectId, environmentId: environmentId ?? null, design: parsed.data });
	}, [projectId, environmentId, handleSave, deployIsPending, mutateDeploy]);

	const discardIsPending = discardStaged.isPending;
	const mutateDiscard = discardStaged.mutate;
	/** Edit mode: clear the active environment's staged changes (the Discard action) — once. */
	const handleDiscardStaged = useCallback(() => {
		if (!projectId || discardIsPending) return;
		// The canvas store has already reverted; this clears the durable staged rows behind it.
		mutateDiscard({ projectId, environmentId: environmentId ?? null });
	}, [projectId, environmentId, discardIsPending, mutateDiscard]);

	// ⌘K is bound TWICE on this page: here (the canvas's own command menu) and by the shell's global
	// palette (`components/shell/command-palette.tsx`, a `document` listener). Both used to fire, so
	// one keystroke opened both dialogs and closing the canvas's left the global overlay over the
	// board. On the canvas the canvas's menu wins: this listener runs in the CAPTURE phase on
	// `window`, which is ahead of any `document` listener in either phase, and stops the event there.
	useEffect(() => {
		const onCmdK = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				e.stopPropagation();
				setCmdOpen((o) => !o);
			}
		};
		window.addEventListener("keydown", onCmdK, { capture: true });
		return () => window.removeEventListener("keydown", onCmdK, { capture: true });
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			if (mod && e.key.toLowerCase() === "s") {
				// Swallowed in BOTH modes so the browser's own Save-page dialog never lands on the
				// canvas. Create flow: create the project. Edit mode: save the design without deploying.
				e.preventDefault();
				if (projectId) handleSaveDesign();
				else handleSave();
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
			const t = e.target instanceof HTMLElement ? e.target : null;
			const typing =
				!!t &&
				(t.tagName === "INPUT" ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable);
			if (typing) return;
			if (e.key === "Escape") {
				// A dialog or menu owns its own Escape; the rail's card closes on the board's.
				if (t?.closest('[role="dialog"],[role="menu"],[role="listbox"]')) return;
				if (useCanvasStore.getState().card) closeCard();
				return;
			}
			if (e.key === "Backspace" || e.key === "Delete") {
				// Through the store, not React Flow's `deleteKeyCode`: respects `deletable: false`
				// and commits an undo step, like every other delete path.
				if (t?.closest('[role="dialog"],[role="menu"]')) return;
				if (selectedIds.length) {
					e.preventDefault();
					removeNodes(selectedIds);
				}
				return;
			}
			if (e.key === " ") {
				// Space-to-pan (Excalidraw/Figma). preventDefault stops the page from scrolling.
				e.preventDefault();
				setSpaceHeld(true);
				return;
			}
			if (e.key.toLowerCase() === "h") {
				// Toggle the sticky hand (pan) tool.
				setHandTool((v) => !v);
				return;
			}
			if (e.key === "a") {
				// No component-add while an IaC source governs the env (replace mode).
				if (!iacGoverned) setPaletteOpen(true);
				return;
			}
			if (e.key === "?") {
				setShortcutsOpen((o) => !o);
				return;
			}
			if (e.key === "Enter" && selectedIds[0])
				openInspectorExclusive(selectedIds[0]);
		};
		const onKeyUp = (e: KeyboardEvent) => {
			if (e.key === " ") setSpaceHeld(false);
		};
		// If the window loses focus mid-hold, keyup never fires — reset so pan can't stick on.
		const onBlur = () => setSpaceHeld(false);
		window.addEventListener("keydown", onKey);
		window.addEventListener("keyup", onKeyUp);
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("keyup", onKeyUp);
			window.removeEventListener("blur", onBlur);
		};
	}, [
		handleSave,
		handleSaveDesign,
		selectedIds,
		openInspectorExclusive,
		openAssistantExclusive,
		projectId,
		undo,
		redo,
		duplicateNodes,
		removeNodes,
		closeCard,
		iacGoverned,
	]);

	const boardContent = (
		<CanvasInteractionContext.Provider value={interaction}>
			{/* Keyed by the active environment so switching envs (picker / Shift+Tab) crossfades
			    the canvas instead of snapping to the new env's design. */}
			<motion.div
				key={environmentId ?? "default"}
				initial={{ opacity: 0 }}
				animate={{ opacity: 1 }}
				transition={{ duration: 0.15 }}
				className="h-full"
			>
				<CanvasFlow
					onPaneContextMenu={contextMenu.onPaneContextMenu}
					onNodeContextMenu={contextMenu.onNodeContextMenu}
					onSelectionContextMenu={contextMenu.onSelectionContextMenu}
				/>
			</motion.div>

			{/* A board with nothing designed on it says what to do next (F037), instead of an empty
			    dotted plane. Not while an IaC module governs the env: there is nothing to add. */}
			{seeded && designEmpty && !iacGoverned && (
				<BoardGuide onAdd={() => setPaletteOpen(true)} />
			)}

			{/* The environment-status read failed with nothing to show: say so, rather than let every
			    node quietly read as its design state. */}
			<EnvironmentStatusNotice />

			{/* Until the store holds this environment's design, the board is the same picture of it the
			    server painted (`BoardPreview`, #6348) — never an empty canvas (F009), and no step back to
			    a skeleton between the server's board and the live one. */}
			{!seeded && <BoardPreview overlay />}

			{/* Bottom-right: the BYO IaC module's PROVENANCE — repo · ref · the commit the scan pinned ·
			    the scan verdict, with detach/rescan. It is not part of the architecture; it's where the
			    architecture came from. The module's resources are real cards on the board above.
			    (This used to be a full-canvas takeover that dimmed the graph and showed this one card.
			    A customer who brought an entire infrastructure was shown a single box.) */}
			{iacGoverned && iacSource && (
				<div className="absolute bottom-3 right-3 z-10">
					<IacNode source={iacSource} />
				</div>
			)}

			{/* Bottom-left: scanned source repos + monorepo services (hidden when none). */}
			<SourceReposCard />

			{/* Top-left: the job running now, else the last one — opens the Activity card. */}
			{projectId && environmentId && <ActivityStatusLine loadDestroyTree={loadDestroyTree} />}

			{/* Top-right: cost · run a job · add a service. (Ask AI lives in the app shell.) */}
			<div className="absolute right-3 top-3 z-10 flex items-center gap-2">
				{/* What this environment costs, from its last PLAN. The runner has always priced every
				    plan with Infracost; nobody ever wrote the number down, so the product could not
				    answer "what does production cost?". */}
				{projectId && environmentId && <CostChip />}

				{/* Every job type the platform can run — PLAN / AUDIT / DETECT_DRIFT / PROBE_CLUSTER —
				    all of which existed server-side and none of which the board could ask for. */}
				{projectId && environmentId && (
					<RunMenu projectId={projectId} environmentId={environmentId} />
				)}
				{/* Adding components is meaningless while an IaC source governs the env (replace mode). */}
				{!iacGoverned && (
					<Button
						type="button"
						size="sm"
						className="h-8 text-xs"
						onClick={() => setPaletteOpen(true)}
					>
						<Plus className="mr-1 h-3.5 w-3.5" />
						Add
					</Button>
				)}
				{/* Everything else — the two cards, the View submenu, the shortcut sheet. */}
				<CanvasMoreMenu
					iacGoverned={iacGoverned}
					onShowShortcuts={() => setShortcutsOpen(true)}
				/>
			</div>

			{/* Bottom-left: settings / zoom / fit / undo-redo / layers */}
			<CanvasControls />

			{/* Bottom-center: staged changes → Deploy / Discard (Destroy now lives in Project settings) */}
			<PendingChangesBar
				onDeploy={projectId ? handleDeploy : handleSave}
				deploying={deploying}
				deployLabel={projectId ? "Deploy" : "Create project"}
				onDiscard={projectId ? handleDiscardStaged : undefined}
				discarding={discardStaged.isPending}
				onSave={projectId ? handleSaveDesign : undefined}
				saving={saving}
			/>

			<CanvasContextMenu
				state={contextMenu.state}
				onClose={contextMenu.close}
				iacGoverned={iacGoverned}
				onAddService={() => setPaletteOpen(true)}
			/>

			<NodePalette
				open={paletteOpen}
				onOpenChange={setPaletteOpen}
				identities={cloudIdentities}
				addonItems={addonsQuery.data?.items}
				onConfigureAddon={projectId ? openConfigureAddon : undefined}
				dropPosition={dropPosition}
			/>
			<CanvasCommandPalette
				open={cmdOpen}
				onOpenChange={setCmdOpen}
				onSave={projectId ? undefined : handleSave}
				onToggleView={onToggleForm}
				onFitView={() => fitView({ padding: 0.3 })}
				fitViewDisabled={!hasDrawnNodes}
				onAskAi={openAssistantExclusive}
				onArrange={() => void arrangeBoard(fitView)}
				onEnvSettings={iacGoverned ? undefined : () => openCard({ kind: "env-settings" })}
				onActivity={
					projectId && environmentId ? () => openCard({ kind: "activity" }) : undefined
				}
				dropPosition={dropPosition}
				onAttachChart={
					byoHelmEnabled && projectId ? () => setByoDialogOpen(true) : undefined
				}
				onAttachIac={
					byoIacEnabled && projectId && !iacGoverned
						? () => setIacDialogOpen(true)
						: undefined
				}
				disableComponentAdd={iacGoverned}
			/>
			{projectId && byoHelmEnabled && (
				<ByoChartDialog
					open={byoDialogOpen}
					onOpenChange={setByoDialogOpen}
					projectId={projectId}
					environmentId={environmentId ?? null}
				/>
			)}
			{projectId && byoIacEnabled && (
				<ByoIacDialog
					open={iacDialogOpen}
					onOpenChange={setIacDialogOpen}
					projectId={projectId}
					environmentId={environmentId ?? null}
				/>
			)}

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
								<kbd className="border border-border px-1.5 py-0.5 font-mono text-ui-xs">
									{s.keys}
								</kbd>
							</div>
						))}
					</div>
				</DialogContent>
			</Dialog>
		</CanvasInteractionContext.Provider>
	);

	// Chart + IaC nodes (rendered propless: chart nodes by React Flow, the IaC overlay by the board)
	// reach the project/env (and the attached IaC source) via context.
	const withByoContext = (content: React.ReactNode) =>
		projectId ? (
			<ByoChartCanvasProvider
				value={{
					projectId,
					environmentId: environmentId ?? null,
				}}
			>
				<IacSourceCanvasProvider
					value={{
						projectId,
						environmentId: environmentId ?? null,
						source: iacSource,
					}}
				>
					{content}
				</IacSourceCanvasProvider>
			</ByoChartCanvasProvider>
		) : (
			content
		);

	// The board and the workspace rail, one flex row, on every route: the rail lives INSIDE the
	// canvas so each card sits under the React Flow provider and the BYO providers above. The
	// board's right border is the seam the rail's card butts against; it appears only while a card
	// is showing, so a closed rail leaves no stray line.
	return withByoContext(
		<div className="flex h-full min-h-[480px] w-full">
			<div
				className={cn(
					"relative min-h-[480px] min-w-0 flex-1",
					isRailOpen(card, { projectId, environmentId }) && "border-r border-border",
				)}
			>
				{boardContent}
			</div>
			<WorkspaceRail
				projectId={projectId}
				environmentId={environmentId ?? null}
				destroyEnvironment={destroyEnvironment}
			/>
		</div>,
	);
}

