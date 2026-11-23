"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { cn } from "@repo/ui/utils";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useStore } from "zustand";
import {
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
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { useAddonsQuery } from "@/lib/query/use-addons-query";
import { arrangeBoard } from "@/lib/canvas/arrange";
import { draftScope } from "@/lib/canvas/design-revision";
import {
	BoardSourcesProvider,
	useBoard,
	useOthers,
} from "@/lib/canvas/store/canvas-store-provider";
import {
	useBoardActions,
	useCard,
	useSelection,
	useSubject,
} from "@/lib/canvas/store/use-board";
import { useIacOutputs, useOutOfBandNodes } from "@/lib/canvas/store/use-board-sources";
import type { WorkspaceCard } from "@/lib/canvas/store/types";
import { environmentStatusInput } from "@/lib/query/use-environment-status-query";
import { DESTROY_HOLD_KEY } from "@/lib/query/topics";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { orpc } from "@/lib/rpc/client";
import { useShortcut } from "@/lib/shortcuts/use-shortcut";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { designSaveSchema } from "@/lib/validations/project-form.schema";
import type { DestroyOptions } from "./cards/destroy-tree-view";
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
import { graphToForm } from "./graph/graph-to-form";
import { NodePalette } from "./node-palette";
import { BoardGuide } from "./board-guide";
import { BoardPreview } from "./board-preview";
import { EnvironmentStatusNotice } from "./environment-status-notice";
import { EnvironmentStatusScope } from "./environment-status-scope";
import {
	SHORTCUT_BOARD_REMOVE,
	SHORTCUT_BOARD_REMOVE_BACKSPACE,
} from "./nodes/board-shortcuts";
import {
	SHORTCUT_CANVAS_ADD,
	SHORTCUT_CANVAS_ASSISTANT,
	SHORTCUT_CANVAS_CLOSE,
	SHORTCUT_CANVAS_DUPLICATE,
	SHORTCUT_CANVAS_FIT,
	SHORTCUT_CANVAS_HAND,
	SHORTCUT_CANVAS_PALETTE,
	SHORTCUT_CANVAS_REDO,
	SHORTCUT_CANVAS_SELECT,
	SHORTCUT_CANVAS_SHORTCUTS,
	SHORTCUT_CANVAS_TIDY,
	SHORTCUT_CANVAS_UNDO,
} from "./toolbar/canvas-keys";
import { saveRefusalMessage, schemaIssues } from "./review/review-issues";
import { CanvasToolbar } from "./toolbar/canvas-toolbar";
import { freeSpot } from "./toolbar/place-new";
import { savedRevision } from "./toolbar/saved-revision";
import { ShortcutSheet } from "./toolbar/shortcut-sheet";

interface DesignProjectCanvasProps {
	cloudIdentities: CloudIdentityOption[];
	/** The live project whose active environment the board saves, deploys and destroys. */
	projectId: string;
	/** The environment the page resolved; absent when it could not resolve one, and the server
	 * then falls back to the project's default. */
	environmentId?: string;
	/** The project's name — what a cascading destroy asks the user to type. */
	projectName?: string;
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

/** A point on the screen, in viewport CSS pixels. */
interface ScreenPoint {
	x: number;
	y: number;
}

/** The canvas editor surface (inside its own ReactFlowProvider and environment-status read). */
export function DesignProjectCanvas(props: DesignProjectCanvasProps) {
	return (
		<ReactFlowProvider>
			<EnvironmentStatusScope projectId={props.projectId} environmentId={props.environmentId}>
				<BoardSources {...props}>
					<CanvasInner {...props} />
				</BoardSources>
			</EnvironmentStatusScope>
		</ReactFlowProvider>
	);
}

/**
 * The board's out-of-band layers, read where they live. BYO charts, their described workloads,
 * installed add-ons and a BYO-IaC module's resources are each a GET procedure the Architecture page
 * prefetched under this same input, so the first paint carries them; a change to any of them
 * arrives as a hint on the org's change stream and invalidates the key (lib/query/topics.ts). They
 * are built into cards in a `useMemo` (`useOutOfBandNodes`) and handed to everything on the board
 * through context: nothing copies them into the board's stores, so undo, discard and the draft can
 * never contain one, and a refetch can never leave a stale copy behind.
 */
function BoardSources({
	projectId,
	environmentId,
	byoHelmEnabled,
	byoDescribeEnabled,
	children,
}: DesignProjectCanvasProps & { children: ReactNode }) {
	const others = useOutOfBandNodes({ projectId, environmentId, byoHelmEnabled, byoDescribeEnabled });
	// The module's output names ride the same round-trip as its cards, so a service binding's
	// facet→output picker (#823) has choices whenever there are BYO-IaC cards to bind to.
	const iacOutputs = useIacOutputs();
	return (
		<BoardSourcesProvider others={others} iacOutputs={iacOutputs}>
			{children}
		</BoardSourcesProvider>
	);
}

function CanvasInner({
	cloudIdentities,
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
	const { fitView, screenToFlowPosition } = useReactFlow();
	const hasDrawnNodes = useHasDrawnNodes();
	// The board in scope: its view store holds the hand tool and what the right-hand panel shows.
	const board = useBoard();
	// The middle of what the board shows, in flow coordinates — where an add lands unless it was
	// asked for at a point. Computed here (inside the ReactFlowProvider) and handed to the palettes
	// so they don't each need the React Flow context (and stay testable without a provider).
	const boardCentre = useDropPosition();
	const [paletteOpen, setPaletteOpen] = useState(false);
	// Where the add picker's node lands when the picker was opened at a point (the pane's context
	// menu); null for the toolbar's Add and the `A` key, which add in the middle of the view.
	const [addAt, setAddAt] = useState<ScreenPoint | null>(null);
	const [cmdOpen, setCmdOpen] = useState(false);
	// The element under the toolbar where the empty state draws its one sentence about a seed.
	const [noticeRegion, setNoticeRegion] = useState<HTMLDivElement | null>(null);
	// Traversal mode (Excalidraw/Miro): the sticky hand tool (the toolbar's Select / Hand pair, `V`
	// and `H`). It is view state, so it lives in the board's view store; the board itself still
	// reads it from CanvasInteractionContext. Holding Space to pan is React Flow's own
	// (`panActivationKeyCode`), so nothing here tracks the Space key any more.
	const handTool = useStore(board.view, (s) => s.handTool);
	const interaction = useMemo(
		() => ({
			handTool,
			setHandTool: (next: boolean) => board.view.getState().setHandTool(next),
			spaceHeld: false,
		}),
		[handTool, board],
	);
	// Right-click. Held here for the same reason as the hand tool: which menu is showing is view
	// interaction, not design state. The three handlers go to the board (React Flow raises the
	// events); the menu itself renders below, next to the palettes.
	const contextMenu = useCanvasContextMenu();
	// Cluster add-ons for this environment — browsed from the Add palette,
	// configured in a card on the workspace rail. Add-ons live on the canvas now (the standalone
	// page was retired).
	const addonsQuery = useAddonsQuery(projectId, environmentId);
	const [byoDialogOpen, setByoDialogOpen] = useState(false);
	const [iacDialogOpen, setIacDialogOpen] = useState(false);
	// The environment's attached BYO IaC source (flag on) — the module's provenance:
	// repo · ref · pinned commit · scan verdict, with detach/rescan. Its RESOURCES are separate: they
	// are external nodes on the board (`BoardSources`, above), because a customer who brought an
	// entire infrastructure should see an architecture, not one card over a dimmed graph.
	const openCard = useCallback(
		(next: WorkspaceCard | null) => board.view.getState().openCard(next),
		[board],
	);
	const closeCard = useCallback(() => board.view.getState().openCard(null), [board]);
	const card = useCard();
	const openConfigureAddon = useCallback(
		(item: AddonMarketItem) => openCard({ kind: "addon", itemId: item.id }),
		[openCard],
	);
	const openPanel = useElenchStore((s) => s.openPanel);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const selectedIds = useSelection();
	const actions = useBoardActions();
	const { undo, redo, duplicateNodes, removeNodes } = actions;
	// The seed the store holds: which scope and server revision the draft was seeded from.
	const seed = useStore(board.document, (s) => s.seed);
	// Whether the store holds THIS environment's design yet. Until it does, the board shows the
	// skeleton over itself rather than an empty canvas (F009).
	const seeded = seed?.scope === draftScope(projectId, environmentId);
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
	// invalidated when it settles. A destroy moves the environment's status, its job history, the
	// environments list and what a held destroy waits on.
	//
	// There is no deploy here (#6833, decision M23). A deploy is offered in one place, the review
	// view the changes bar opens, and only through `usePlanReview(serverCurrent).gate`: for a plan of
	// the saved design that was reviewed. A second deploy path in this file would be a way round it.
	const environmentKeys = [orpc.canvas.environmentStatus.key(), orpc.canvas.environmentJobs.key()];
	// The revision the write in flight will leave the server design at (`savedRevision`), noted when
	// the write is sent and recorded when it lands.
	const writtenRevision = useRef<string | undefined>(undefined);
	/**
	 * The design on the board is now the saved one. The changes bar diffs against the baseline, so
	 * committing it is what clears the bar; passing the revision the save produced is what stops the
	 * server's next render of that same design from being taken for somebody else's change, which
	 * would lay the board out afresh and discard the arrangement.
	 */
	const commitSaved = useCallback(() => {
		board.document.getState().commitBaseline(writtenRevision.current);
		writtenRevision.current = undefined;
	}, [board]);
	const saveDesign = useActionMutation(saveDesignAction, {
		invalidates: [orpc.canvas.environmentStatus.key()],
		successMessage: "Design saved",
		onSuccess: commitSaved,
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
	const saving = saveDesign.isPending;

	/**
	 * Read the active environment's destroy tree (#5261) — the `canvas.destroyTree` GET
	 * procedure, always fresh: the Environment settings card reads it BEFORE it offers to destroy, so
	 * the tenants it names are seen first, and an answer from before a tenant moved would be a wrong one.
	 */
	const loadDestroyTree = useCallback(async () => {
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
	 * Tear down the environment the destroy tree named — with `cascade`, every tenant on
	 * its cluster too. The id comes from the tree the dialog showed, never from the board's own
	 * (possibly stale) environment, so what is destroyed is what was confirmed.
	 */
	const handleDestroyEnvironment = useCallback(
		async ({ cascade, environmentId: target }: DestroyOptions) => {
			if (destroyIsPending) return;
			try {
				await mutateDestroy({ projectId, environmentId: target, cascade });
			} catch {
				// Already said by the mutation: a refusal ("destroy the children first") in one toast.
			}
		},
		[projectId, destroyIsPending, mutateDestroy],
	);

	const destroyEnvironment = useMemo(
		() => ({
			projectName: projectName ?? null,
			loadTree: loadDestroyTree,
			destroy: handleDestroyEnvironment,
		}),
		[projectName, loadDestroyTree, handleDestroyEnvironment],
	);

	const envInput = environmentStatusInput(projectId, environmentId);

	// BYO IaC source is single-per-env: the module's provenance card, from `canvas.iacSource`. Only
	// with the feature on; attach / detach / rescan invalidate it (their mutations' keys).
	const iacSourceQuery = useQuery({
		...orpc.canvas.iacSource.queryOptions({ input: envInput }),
		enabled: !!byoIacEnabled,
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
		if (byoHelmEnabled && searchParams.get("attachChart") === "1") {
			setByoDialogOpen(true);
			router.replace(window.location.pathname);
		}
	}, [byoHelmEnabled, searchParams, router]);

	// Repo-first on-ramp: the new-project "Bring your own IaC" path lands here with
	// ?attachIac=1 → auto-open the attach flow, then strip the param so a refresh doesn't re-open.
	useEffect(() => {
		if (byoIacEnabled && searchParams.get("attachIac") === "1") {
			setIacDialogOpen(true);
			router.replace(window.location.pathname);
		}
	}, [byoIacEnabled, searchParams, router]);

	/** Open the Elench assistant as a docked panel for this project. */
	const openAssistantExclusive = useCallback(() => {
		openPanel({ kind: "project", projectId, environmentId: environmentId ?? null });
	}, [openPanel, projectId, environmentId]);

	const saveIsPending = saveDesign.isPending;
	const mutateSave = saveDesign.mutate;
	/**
	 * Persist the desired config to the live project WITHOUT provisioning. There was no such path —
	 * the pending-changes bar's only verb was Deploy, so a design you were not ready to provision had
	 * nowhere to go but the tab's sessionStorage draft. `saveDesignAction` writes the live design
	 * tables and clears the environment's staged rows; `commitBaseline` clears the bar. There is one
	 * save: a second one that persisted without committing the baseline would leave the bar
	 * reporting changes that are already written.
	 */
	const handleSaveDesign = useCallback(() => {
		if (saveIsPending) return;
		// The SAVE schema, not the deploy one: a project with no cloud account yet can still save its
		// design (#7272). A refusal is told in the review's words, never as a validator path.
		const nodes = actions.nodes();
		const parsed = designSaveSchema.safeParse(graphToForm(nodes));
		if (!parsed.success) {
			toast.error(saveRefusalMessage(schemaIssues(nodes, parsed.error.issues)));
			return;
		}
		// The revision is the hash of the design as the server will READ it back, and the read
		// (`getProjectAsFormData`) answers a project with no account as `""`, not the NULL stored.
		const design = parsed.data;
		writtenRevision.current = savedRevision(board.document.getState().seed?.revision, {
			...design,
			project: { ...design.project, cloud_identity_id: design.project.cloud_identity_id ?? "" },
		});
		mutateSave({ projectId, environmentId: environmentId ?? null, design });
	}, [projectId, environmentId, saveIsPending, mutateSave, board, actions]);

	const discardIsPending = discardStaged.isPending;
	const mutateDiscard = discardStaged.mutate;
	/** Clear the active environment's staged changes (the Discard action) — once. */
	const handleDiscardStaged = useCallback(() => {
		if (discardIsPending) return;
		// The canvas store has already reverted; this clears the durable staged rows behind it.
		mutateDiscard({ projectId, environmentId: environmentId ?? null });
	}, [projectId, environmentId, discardIsPending, mutateDiscard]);

	/** Open the add picker. With a point, the picked node lands there; without, mid-view. */
	const openAdd = useCallback((point?: ScreenPoint) => {
		setAddAt(point ?? null);
		setPaletteOpen(true);
	}, []);

	/** The add picker opened or closed. A closed picker forgets the point it was opened at. */
	const onPaletteOpenChange = useCallback((open: boolean) => {
		setPaletteOpen(open);
		if (!open) setAddAt(null);
	}, []);

	/**
	 * Where a new card lands: the point asked for, else the middle of what the board shows — and
	 * from there, the nearest place where no card already sits, so two adds in a row are two cards
	 * on screen and not one drawn over the other.
	 */
	const placeNew = useCallback(
		(point: ScreenPoint | null) =>
			freeSpot(
				point ? screenToFlowPosition(point) : boardCentre(),
				Object.values(board.document.getState().positions),
			),
		[screenToFlowPosition, boardCentre, board],
	);

	const fitBoard = useCallback(() => {
		if (hasDrawnNodes) void fitView({ padding: 0.3 });
	}, [hasDrawnNodes, fitView]);
	const others = useOthers();
	const tidyBoard = useCallback(() => {
		if (hasDrawnNodes) void arrangeBoard(board, others, fitView);
	}, [hasDrawnNodes, board, others, fitView]);

	// ── The board's keys ─────────────────────────────────────────────────────────────────────────
	//
	// Every key is a row of the console's shortcut registry (`toolbar/canvas-keys.ts`, `canvas`
	// scope) answered here through `useShortcut`: this file adds no key listener of its own. The
	// registry is what keeps a bare key from firing while the caret is in a field, and a chord from
	// firing inside a dialog or a menu, so no handler below asks either question — the two listeners
	// this replaced asked them by hand, and asked them AFTER handling ⌘S and ⌘D.
	//
	// ⌘K is the board's while the board is mounted: a `canvas` row outranks the shell's `global` row
	// for the same chord, which is what the capture-phase listener that used to sit here was for.
	//
	// A key that has nothing to act on is not enabled, so pressing it is left entirely to the
	// browser: Backspace with nothing selected is not swallowed.
	useShortcut(SHORTCUT_CANVAS_PALETTE, () => setCmdOpen((open) => !open));
	// No component-add while an IaC source governs the env (replace mode).
	useShortcut(SHORTCUT_CANVAS_ADD, () => openAdd(), { enabled: !iacGoverned });
	useShortcut(SHORTCUT_CANVAS_SELECT, () => board.view.getState().setHandTool(false));
	useShortcut(SHORTCUT_CANVAS_HAND, () => {
		const view = board.view.getState();
		view.setHandTool(!view.handTool);
	});
	useShortcut(SHORTCUT_CANVAS_UNDO, undo);
	useShortcut(SHORTCUT_CANVAS_REDO, redo);
	// Always taken, so the browser's "bookmark this page" never opens over the board.
	useShortcut(SHORTCUT_CANVAS_DUPLICATE, () => {
		if (selectedIds.length) duplicateNodes(selectedIds);
	});
	// ⌘S is the changes bar's: it opens the review (`pending-changes-bar.tsx`), the one way from an
	// edit to a deploy.
	useShortcut(SHORTCUT_CANVAS_ASSISTANT, openAssistantExclusive);
	useShortcut(SHORTCUT_CANVAS_FIT, fitBoard);
	useShortcut(SHORTCUT_CANVAS_TIDY, tidyBoard);
	useShortcut(SHORTCUT_CANVAS_SHORTCUTS, () => setShortcutsOpen((open) => !open));
	// Through the store, not React Flow's `deleteKeyCode`: respects `deletable: false` and commits
	// an undo step, like every other delete path.
	const removeSelected = useCallback(() => removeNodes(selectedIds), [removeNodes, selectedIds]);
	// Delete and Backspace are the board's rows (`nodes/board-shortcuts.ts`): the board answers them
	// for a selected connection, this answers them for selected cards.
	useShortcut(SHORTCUT_BOARD_REMOVE, removeSelected, { enabled: selectedIds.length > 0 });
	useShortcut(SHORTCUT_BOARD_REMOVE_BACKSPACE, removeSelected, {
		enabled: selectedIds.length > 0,
	});
	// Escape closes the inspector. A dialog or a menu owns its own Escape (the registry does not
	// fire inside one), and so does an open list of options. The rail closes itself as well when
	// the focus is inside it; this is the same answer from anywhere else on the board.
	useShortcut(
		SHORTCUT_CANVAS_CLOSE,
		(event) => {
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest('[role="listbox"]')) return;
			closeCard();
		},
		{ enabled: card !== null },
	);

	// The review view docks on the board's right edge while no card is open on the rail
	// (`pending-changes-bar.tsx`). The toolbar's region gives that width back, so the toolbar is
	// centred over what is left of the board instead of running under the view.
	const reviewOpen = useStore(board.view, (s) => s.review.open);
	const subject = useSubject();
	const reviewDocked = reviewOpen && subject === null;
	const tab = useStore(board.view, (s) => s.tab);
	const sourcesOpen = subject?.kind === "environment" && tab === "sources";
	/** Open the environment's Sources on the rail, or close it when that is what is showing. */
	const toggleSources = () =>
		board.view.getState().setSubject(sourcesOpen ? null : { kind: "environment" }, "sources");

	// ── The board's regions ──────────────────────────────────────────────────────────────────────
	//
	//   top-centre     the toolbar, and under it what has to be said in place (the status notice,
	//                  the empty state's sentence about a seed)
	//   bottom-left    how the board is looked at: zoom and fit
	//   bottom-centre  the changes bar
	//   right          the inspector, a flex sibling of the board, so it never covers a card
	//
	// Nothing else is drawn over the board. The activity line (top-left), the cost chip, Run, Add
	// and ⋯ (top-right) moved into the toolbar; the source-repos card (bottom-left, over the zoom
	// controls) and the IaC provenance card (bottom-right, over the minimap) are the inspector's
	// Sources view, which the toolbar's Sources tool opens.
	const boardContent = (
		<CanvasInteractionContext.Provider value={interaction}>
			{/* Keyed by the active environment so switching envs (the picker, or its key) remounts it
			    and fades the new env's design in (`canvas-env-in`, app/globals.css) instead of snapping. */}
			<div key={environmentId ?? "default"} className="canvas-env-in h-full">
				<CanvasFlow
					onPaneContextMenu={contextMenu.onPaneContextMenu}
					onNodeContextMenu={contextMenu.onNodeContextMenu}
					onSelectionContextMenu={contextMenu.onSelectionContextMenu}
				/>
			</div>

			{/* How a board starts (#6836): a `?seed=` from the create screen is applied once, and a board
			    with nothing drawn on it says what it is and offers the ways to start, instead of an
			    empty dotted plane. It decides for itself when the guide shows. */}
			{seeded && (
				<BoardGuide
					projectId={projectId}
					environmentId={environmentId}
					byoHelmEnabled={byoHelmEnabled}
					byoDescribeEnabled={byoDescribeEnabled}
					governed={iacGoverned}
					onAdd={() => openAdd()}
					onAttachChart={byoHelmEnabled ? () => setByoDialogOpen(true) : undefined}
					onAttachIac={byoIacEnabled ? () => setIacDialogOpen(true) : undefined}
					noticeRegion={noticeRegion}
				/>
			)}

			{/* Top-centre: the toolbar, then what it opens in place. The region lets every pointer
			    event it does not own through to the board; `@container` is what lets the toolbar drop
			    its secondary tools when the region is narrow. */}
			<div
				className={cn(
					"pointer-events-none absolute inset-x-0 top-3 z-[var(--z-raised)] flex justify-center px-3",
					reviewDocked && "pr-[calc(min(560px,100%)+0.75rem)]",
				)}
			>
				<div className="@container flex w-full min-w-0 flex-col items-center gap-2">
					<CanvasToolbar
						projectId={projectId}
						environmentId={environmentId}
						governed={iacGoverned}
						addOpen={paletteOpen}
						onAdd={() => openAdd()}
						paletteOpen={cmdOpen}
						onOpenPalette={() => setCmdOpen(true)}
						shortcutsOpen={shortcutsOpen}
						onShowShortcuts={() => setShortcutsOpen(true)}
						onUndo={undo}
						onRedo={redo}
						onTidy={tidyBoard}
						onFitView={fitBoard}
						sourcesOpen={sourcesOpen}
						onToggleSources={toggleSources}
					/>

					{/* The environment-status read failed with nothing to show: say so, rather than let
					    every node quietly read as its design state. */}
					<EnvironmentStatusNotice />

					{/* The empty state's one sentence about a seed (`board-guide.tsx`) is drawn here. */}
					<div ref={setNoticeRegion} className="flex max-w-full justify-center empty:hidden" />
				</div>
			</div>

			{/* Until the store holds this environment's design, the board is the same picture of it the
			    server painted (`BoardPreview`, #6348) — never an empty canvas (F009), and no step back to
			    a skeleton between the server's board and the live one. It is drawn after the toolbar's
			    region, on the same layer, so it covers the live controls until they can be used. */}
			{!seeded && <BoardPreview overlay />}

			{/* Bottom-left: zoom out / level / zoom in / fit. */}
			<CanvasControls />

			{/* Bottom-centre: the pending changes, and the way from them to a deploy. */}
			<PendingChangesBar
				projectId={projectId}
				environmentId={environmentId ?? null}
				onDiscard={handleDiscardStaged}
				discarding={discardStaged.isPending}
				onSave={handleSaveDesign}
				saving={saving}
			/>

			<CanvasContextMenu
				state={contextMenu.state}
				onClose={contextMenu.close}
				iacGoverned={iacGoverned}
				onAddService={openAdd}
			/>

			<NodePalette
				open={paletteOpen}
				onOpenChange={onPaletteOpenChange}
				identities={cloudIdentities}
				addonItems={addonsQuery.data?.items}
				onConfigureAddon={openConfigureAddon}
				onAttachChart={byoHelmEnabled ? () => setByoDialogOpen(true) : undefined}
				onAttachIac={byoIacEnabled ? () => setIacDialogOpen(true) : undefined}
				governed={iacGoverned}
				dropPosition={() => placeNew(addAt)}
			/>
			<CanvasCommandPalette
				open={cmdOpen}
				onOpenChange={setCmdOpen}
				onFitView={fitBoard}
				fitViewDisabled={!hasDrawnNodes}
				onAskAi={openAssistantExclusive}
				onArrange={tidyBoard}
				onEnvSettings={iacGoverned ? undefined : () => openCard({ kind: "env-settings" })}
				onActivity={environmentId ? () => openCard({ kind: "activity" }) : undefined}
				onShowShortcuts={() => setShortcutsOpen(true)}
				dropPosition={() => placeNew(null)}
				onAttachChart={byoHelmEnabled ? () => setByoDialogOpen(true) : undefined}
				onAttachIac={
					byoIacEnabled && !iacGoverned
						? () => setIacDialogOpen(true)
						: undefined
				}
				disableComponentAdd={iacGoverned}
			/>
			{byoHelmEnabled && (
				<ByoChartDialog
					open={byoDialogOpen}
					onOpenChange={setByoDialogOpen}
					projectId={projectId}
					environmentId={environmentId ?? null}
				/>
			)}
			{byoIacEnabled && (
				<ByoIacDialog
					open={iacDialogOpen}
					onOpenChange={setIacDialogOpen}
					projectId={projectId}
					environmentId={environmentId ?? null}
				/>
			)}

			<ShortcutSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
		</CanvasInteractionContext.Provider>
	);

	// Chart + IaC nodes (rendered propless: chart nodes by React Flow, the IaC overlay by the board)
	// reach the project/env (and the attached IaC source) via context.
	const withByoContext = (content: React.ReactNode) => (
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
