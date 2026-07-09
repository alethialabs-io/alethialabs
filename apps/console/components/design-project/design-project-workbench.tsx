"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { FormProvider, useForm } from "react-hook-form";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import {
	projectFormSchema,
	type ProjectFormData,
	type ProjectFormInput,
} from "@/lib/validations/project-form.schema";
import { DesignProjectCanvas } from "./canvas/design-project-canvas";
import { formToGraph } from "./canvas/graph/form-to-graph";
import { configName } from "./canvas/graph/node-config";
import { ConnectorsProvider } from "./connectors-context";
import { RepositoryProvider } from "./repository-context";
import {
	buildDefaultFormValues,
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
}: DesignProjectWorkbenchProps) {
	const form = useForm<ProjectFormInput, unknown, ProjectFormData>({
		resolver: zodResolver(projectFormSchema),
		defaultValues: buildDefaultFormValues(sourceProject),
		mode: "onChange",
	});

	// Seed the canvas store. Identities are always refreshed; the graph is seeded only
	// when loading a source project or when the store is pristine — otherwise a persisted
	// sessionStorage draft is preserved across reloads/navigation.
	useEffect(() => {
		const store = useCanvasStore.getState();
		store.setIdentities(cloudIdentities);
		const project = store.nodes.find((n) => n.id === PROJECT_NODE_ID);
		const pristine =
			store.nodes.length <= 1 && !(project && configName(project.data));
		if (sourceProject || pristine) {
			store.setGraph(
				formToGraph(buildDefaultFormValues(sourceProject), cloudIdentities),
			);
		}
	}, [cloudIdentities, sourceProject]);

	return (
		<ConnectorsProvider connectors={connectors}>
			<RepositoryProvider>
				<FormProvider {...form}>
					<DesignProjectCanvas
						cloudIdentities={cloudIdentities}
						projectId={projectId}
						environmentId={environmentId}
						dockInShell={dockInShell}
					/>
				</FormProvider>
			</RepositoryProvider>
		</ConnectorsProvider>
	);
}
