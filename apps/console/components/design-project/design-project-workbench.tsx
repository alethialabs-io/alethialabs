"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { draftScope, fnv1a32, stableStringify } from "@/lib/canvas/design-revision";
import { boardFor } from "@/lib/canvas/store/board";
import { CanvasStoreProvider } from "@/lib/canvas/store/canvas-store-provider";
import { RegionError } from "@repo/ui/region-error";
import { BoardPreview, BoardPreviewProvider } from "./canvas/board-preview";
import { formToGraph } from "./canvas/graph/form-to-graph";
import { ConnectorsProvider } from "./connectors-context";
import { RepositoryProvider } from "./repository-context";
import {
	buildDefaultFormValues,
	sourceRevision,
	type SourceProjectData,
} from "./source-project";

/**
 * The board, loaded at the point of use (#6119). It is the whole of `@xyflow/react`, `motion` and
 * every card, palette and inspector; a static import put all of it in front of the route's FIRST
 * hydration (the #5849 lesson). React Flow measures the DOM, so it is not server-rendered.
 *
 * What the server sends in its place is the BOARD, not a skeleton (#6348, RUBRIC B1): the design's
 * cards, the environment's last job and cost, the toolbar, or the blank-board guide — all of it
 * data the page already read on the server — drawn without React Flow by `BoardPreview`, which
 * reads the page's data from `BoardPreviewProvider` (a `loading` component takes no props). The
 * client swaps the live board in over the same footprint.
 */
const DesignProjectCanvas = dynamic(
	() => import("./canvas/design-project-canvas").then((m) => m.DesignProjectCanvas),
	{ ssr: false, loading: () => <BoardPreview /> },
);

/**
 * The design read failed on a project route. Not an empty board, and not an endless skeleton: the
 * seed refuses to paint a blank default over a real design (see the seed effect), so without this
 * the board would wait forever for a design that is not coming (RUBRIC B4).
 */
function DesignLoadError() {
	const router = useRouter();
	return (
		<RegionError
			className="h-full"
			title="Couldn't load this environment's design"
			description="The board was not drawn rather than shown blank. Nothing was changed."
			onRetry={() => router.refresh()}
		/>
	);
}

interface DesignProjectWorkbenchProps {
	cloudIdentities: CloudIdentityOption[];
	connectors?: ConnectorWithConnection[];
	sourceProject?: SourceProjectData;
	/** The live project the canvas saves, deploys and destroys. */
	projectId: string;
	/** Its active environment; absent when the page could not resolve one. */
	environmentId?: string;
	/** Whether bring-your-own Helm charts are enabled (server flag) — gates the ⌘K "Sources" entry. */
	byoHelmEnabled?: boolean;
	/** Whether BYO chart-workload DESCRIBE is enabled (server flag) — gates the described-workload
	 * child nodes. */
	byoDescribeEnabled?: boolean;
	/** Whether bring-your-own IaC is enabled (server flag) — gates the ⌘K "Bring your own IaC" entry
	 * + the external-IaC overlay. */
	byoIacEnabled?: boolean;
}

/**
 * Hosts the project canvas, on its one mount: the project's Architecture route. The canvas is the
 * sole design surface (the legacy form was removed); the abstract zod schema + graph⇄form
 * round-trip remain the persistence contract.
 */
export function DesignProjectWorkbench({
	cloudIdentities,
	connectors = [],
	sourceProject,
	projectId,
	environmentId,
	byoHelmEnabled,
	byoDescribeEnabled,
	byoIacEnabled,
}: DesignProjectWorkbenchProps) {
	// The revision whose seed THREW, if any (see the seed effect). A board that cannot be seeded is a
	// failed design load, not a board still loading.
	const [seedFailedFor, setSeedFailedFor] = useState<string | null>(null);

	const scope = draftScope(projectId, environmentId);

	// The seed effect is keyed on WHAT the server design is (project, environment, content hash),
	// never on the identity of the prop carrying it: a server component re-renders on every
	// revalidate and sibling mutation, and each render hands us a new object of the same design.
	// Before this, that re-ran `setGraph`, which closed the open card and discarded every unsaved
	// edit.
	//
	// The identity list is part of the revision, and this is not belt-and-braces. `formToGraph`
	// resolves `providerOf(id)` and BAKES the result into `data.provider` on every node, and
	// `getEffectiveProvider` reads that rather than re-resolving against the list — so the provider
	// stamped on a node is a snapshot of the identity list at seed time. Hashing the list makes a
	// real change re-seed while a re-render with the same list still does not. Found in review.
	// `null` while there is no design to seed from: the design read failed, and nothing is seeded.
	const revision = sourceProject
		? `${sourceRevision(sourceProject)}:${fnv1a32(stableStringify(cloudIdentities))}`
		: null;
	// What to seed from, read at seed time rather than listed as a dependency — the identity of both
	// props changes on every render, and their content is what `revision` already keys on.
	const latest = useRef({ sourceProject, cloudIdentities });
	useEffect(() => {
		latest.current = { sourceProject, cloudIdentities };
	}, [sourceProject, cloudIdentities]);
	// The scope whose draft slot this mount has opened. Opening a scope restores its draft (or
	// resets the board), so it happens once per scope: a revision change within one scope re-seeds
	// the board that is already open.
	const openedScope = useRef<string | null>(null);
	// THE ONE SEED. Everything the board holds of the server design arrives here, keyed on the
	// design's revision. The identity list is read here only to resolve each node's cloud (the
	// revision moves when the list does); the shell reads the list from `CanvasStoreProvider`
	// below, so no effect keeps a copy of it in step.
	useEffect(() => {
		// An environment switch while a seed is still pending: whichever run settles later must not
		// seed the board, or report a failure, for a scope the user has already left.
		let cancelled = false;
		// The page passes `getProjectAsFormData(...).catch(() => undefined)`, so `sourceProject` is
		// undefined on any transient failure — a DB hiccup, an authz blip, a revalidate racing a
		// write — and seeding the blank default over a real board would look exactly like the user's
		// design being deleted. Found in review.
		const source = latest.current.sourceProject;
		if (revision === null || !source) return;
		const identities = latest.current.cloudIdentities;
		// Each environment has its own board; this is the one the provider below publishes.
		const board = boardFor(scope);
		/** Open this scope's draft slot (if this mount has not), then seed under the revision. */
		const seed = () => {
			// Superseded before it ran: the person has moved to the scope that overtook this run.
			if (cancelled) return;
			if (openedScope.current !== scope) {
				openedScope.current = scope;
				board.openDraftScope(scope);
			}
			board.reseed(formToGraph(buildDefaultFormValues(source), identities), {
				scope,
				revision,
			});
		};
		// A seed that throws (`formToGraph` on a design it cannot read) would leave the store
		// unseeded — and the board's skeleton up forever (RUBRIC B4). It is the design load failing,
		// so it renders as one. Keyed by revision, so a later good design clears it. Run as a
		// microtask, so the failure is reported from a callback and never from the effect's body.
		Promise.resolve()
			.then(seed)
			.catch(() => {
				if (!cancelled) setSeedFailedFor(revision);
			});
		return () => {
			cancelled = true;
		};
	}, [scope, revision]);

	// A tab that is closed, reloaded or sent to the background mid-drag would otherwise lose the
	// drag: the draft is written when a drag ENDS, and `pagehide` is the last event a page is
	// promised. Writing the draft there keeps whatever is on the board when the page goes.
	useEffect(() => {
		const board = boardFor(scope);
		const flush = () => board.flushDraft();
		window.addEventListener("pagehide", flush);
		return () => window.removeEventListener("pagehide", flush);
	}, [scope]);

	if (revision === null || seedFailedFor === revision) return <DesignLoadError />;

	return (
		<BoardPreviewProvider
			value={{ sourceProject, cloudIdentities, projectId, environmentId, byoHelmEnabled }}
		>
			<CanvasStoreProvider scope={scope} identities={cloudIdentities}>
				<ConnectorsProvider connectors={connectors}>
					<RepositoryProvider>
						<DesignProjectCanvas
							cloudIdentities={cloudIdentities}
							projectId={projectId}
							environmentId={environmentId}
							projectName={sourceProject?.formData.project.project_name}
							byoHelmEnabled={byoHelmEnabled}
							byoDescribeEnabled={byoDescribeEnabled}
							byoIacEnabled={byoIacEnabled}
						/>
					</RepositoryProvider>
				</ConnectorsProvider>
			</CanvasStoreProvider>
		</BoardPreviewProvider>
	);
}
