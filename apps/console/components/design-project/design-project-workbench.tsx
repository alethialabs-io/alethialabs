"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef } from "react";
import { FormProvider, useForm } from "react-hook-form";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import {
	draftScope,
	fnv1a32,
	NEW_DRAFT_SCOPE,
	stableStringify,
} from "@/lib/canvas/design-revision";
import { switchDraftScope, useCanvasStore } from "@/lib/stores/use-canvas-store";
import {
	projectFormSchema,
	type ProjectFormData,
	type ProjectFormInput,
} from "@/lib/validations/project-form.schema";
import { DesignProjectCanvas } from "./canvas/design-project-canvas";
import { formToGraph } from "./canvas/graph/form-to-graph";
import { ConnectorsProvider } from "./connectors-context";
import { RepositoryProvider } from "./repository-context";
import {
	buildDefaultFormValues,
	sourceRevision,
	type SourceProjectData,
} from "./source-project";

interface DesignProjectWorkbenchProps {
	cloudIdentities: CloudIdentityOption[];
	connectors?: ConnectorWithConnection[];
	sourceProject?: SourceProjectData;
	/** Edit mode: the live project + active environment the canvas deploys/destroys.
	 * Omitted in the create flow (`~/new`), where Deploy creates a new project. */
	projectId?: string;
	environmentId?: string;
	/** True on the project Architecture route — the docked panel is owned by the project shell, so
	 * the canvas renders the board alone. Omitted in the standalone create flow. */
	dockInShell?: boolean;
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
 * Hosts the project canvas. The canvas is the sole design surface (the legacy form was
 * removed); a shared RHF FormProvider is still mounted because some inspector fields
 * (repository / cloud-identity selectors) read form context, and the abstract zod schema
 * + graph⇄form round-trip remain the persistence contract.
 */
export function DesignProjectWorkbench({
	cloudIdentities,
	connectors = [],
	sourceProject,
	projectId,
	environmentId,
	dockInShell,
	byoHelmEnabled,
	byoDescribeEnabled,
	byoIacEnabled,
}: DesignProjectWorkbenchProps) {
	const form = useForm<ProjectFormInput, unknown, ProjectFormData>({
		resolver: zodResolver(projectFormSchema),
		defaultValues: buildDefaultFormValues(sourceProject),
		mode: "onChange",
	});

	// Identities are server data the store looks up for labels; refresh them whenever the server
	// sends a new list.
	useEffect(() => {
		useCanvasStore.getState().setIdentities(cloudIdentities);
	}, [cloudIdentities]);

	// The seed effect is keyed on WHAT the server design is (project, environment, content hash),
	// never on the identity of the prop carrying it: a server component re-renders on every
	// revalidate and sibling mutation, and each render hands us a new object of the same design.
	// Before this, that re-ran `setGraph`, which closed the open card and discarded every unsaved
	// edit. The create flow has no project, so it seeds under the fixed "new" scope + revision and
	// its draft survives a reload exactly as it did before.
	// The identity list is part of the revision, and this is not belt-and-braces. `formToGraph`
	// resolves `providerOf(id)` and BAKES the result into `data.provider` on every node, and
	// `getEffectiveProvider` reads that rather than re-resolving against the store — so the provider
	// stamped on a node is a snapshot of the identity list at seed time. With the seed no longer
	// re-running on every render, a design referencing an identity that arrives in a LATER list
	// would keep whatever provider it was seeded with. Hashing the list makes a real change re-seed
	// while a re-render with the same list still does not, which is the whole point of this effect.
	// Found in review.
	const revision = sourceProject
		? `${sourceRevision(sourceProject)}:${fnv1a32(stableStringify(cloudIdentities))}`
		: NEW_DRAFT_SCOPE;
	// The design to seed from, read at seed time rather than listed as a dependency — its identity
	// changes on every render, its content is what `revision` already keys on.
	const sourceRef = useRef(sourceProject);
	useEffect(() => {
		sourceRef.current = sourceProject;
	}, [sourceProject]);
	// The scope persistence is pointed at, with the switch that pointed it there. `switchDraftScope`
	// moves the pointer synchronously and rehydrates asynchronously, so a later run for the SAME
	// scope awaits the same switch instead of starting another, and a revision change within one
	// scope re-seeds without rehydrating at all.
	const switchRef = useRef<{ scope: string; done: Promise<boolean> } | null>(null);
	useEffect(() => {
		// An environment switch while the previous switch is still in flight: whichever run
		// resolves later must not seed the store for a scope the user has already left.
		let cancelled = false;
		const scope = draftScope(projectId, environmentId);
		// A PROJECT route whose design read failed is not a create flow. The page passes
		// `getProjectAsFormData(...).catch(() => undefined)`, so `sourceProject` is undefined on any
		// transient failure — a DB hiccup, an authz blip, a revalidate racing a write — and seeding
		// the blank default over a real board would look exactly like the user's design being
		// deleted. The create flow is the case with no `projectId` at all. Found in review.
		if (projectId && !sourceRef.current) return;
		/** Point persistence at this scope's slot (if not already), then seed under the revision. */
		const seed = async () => {
			let pending = switchRef.current;
			if (!pending || pending.scope !== scope) {
				// `switchDraftScope` writes to the store AFTER its own await, and the store and the
				// persistence pointer are both global — so a superseded switch resuming late would
				// rehydrate the NEW scope's slot, decide it does not match the scope it was called
				// for, and `reset()` a board that had already been seeded correctly. `cancelled`
				// cannot reach inside it, so it is handed the question instead. Found in review.
				pending = { scope, done: switchDraftScope(scope, () => !cancelled) };
				switchRef.current = pending;
			}
			await pending.done;
			if (cancelled) return;
			const store = useCanvasStore.getState();
			store.reseed(
				formToGraph(buildDefaultFormValues(sourceRef.current), store.identities),
				{ scope, revision },
			);
		};
		void seed();
		return () => {
			cancelled = true;
		};
	}, [projectId, environmentId, revision]);

	return (
		<ConnectorsProvider connectors={connectors}>
			<RepositoryProvider>
				<FormProvider {...form}>
					<DesignProjectCanvas
						cloudIdentities={cloudIdentities}
						projectId={projectId}
						environmentId={environmentId}
						dockInShell={dockInShell}
						byoHelmEnabled={byoHelmEnabled}
						byoDescribeEnabled={byoDescribeEnabled}
						byoIacEnabled={byoIacEnabled}
					/>
				</FormProvider>
			</RepositoryProvider>
		</ConnectorsProvider>
	);
}
