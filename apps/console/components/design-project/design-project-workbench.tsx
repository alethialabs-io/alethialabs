"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { FileText, LayoutGrid } from "lucide-react";
import { useEffect, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { cn } from "@repo/ui/utils";
import {
	projectFormSchema,
	type ProjectFormData,
	type ProjectFormInput,
} from "@/lib/validations/project-form.schema";
import { DesignProjectCanvas } from "./canvas/design-project-canvas";
import { formToGraph } from "./canvas/graph/form-to-graph";
import { graphToForm } from "./canvas/graph/graph-to-form";
import { ConnectorsProvider } from "./connectors-context";
import {
	buildDefaultFormValues,
	DesignProjectFormBody,
	type SourceProjectData,
} from "./design-project-form";
import { RepositoryProvider } from "./repository-context";

interface DesignProjectWorkbenchProps {
	cloudIdentities: CloudIdentityOption[];
	connectors?: ConnectorWithConnection[];
	sourceProject?: SourceProjectData;
	/** Gates the canvas view; when false only the form renders (zero behavior change). */
	canvasEnabled: boolean;
}

type View = "form" | "canvas";

/**
 * Hosts both the form and the canvas over ONE shared RHF form instance. The
 * Canvas⇄Form toggle bridges the two representations on switch (form→canvas seeds
 * the canvas store; canvas→form resets the form from the graph).
 */
export function DesignProjectWorkbench({
	cloudIdentities,
	connectors = [],
	sourceProject,
	canvasEnabled,
}: DesignProjectWorkbenchProps) {
	const [view, setView] = useState<View>("form");

	const form = useForm<ProjectFormInput, unknown, ProjectFormData>({
		resolver: zodResolver(projectFormSchema),
		defaultValues: buildDefaultFormValues(sourceProject),
		mode: "onChange",
	});

	// Seed the canvas store. Identities are always refreshed; the graph is seeded
	// only when duplicating (sourceProject) or when the store is pristine — otherwise a
	// persisted sessionStorage draft is preserved across reloads/navigation.
	useEffect(() => {
		const store = useCanvasStore.getState();
		store.setIdentities(cloudIdentities);
		const project = store.nodes.find((n) => n.id === PROJECT_NODE_ID);
		const pristine =
			store.nodes.length <= 1 && !project?.data.config.project_name;
		if (sourceProject || pristine) {
			store.setGraph(
				formToGraph(buildDefaultFormValues(sourceProject), cloudIdentities),
			);
		}
	}, [cloudIdentities, sourceProject]);

	const toCanvas = () => {
		useCanvasStore
			.getState()
			.setGraph(formToGraph(form.getValues() as ProjectFormData, cloudIdentities));
		setView("canvas");
	};

	const toForm = () => {
		form.reset(
			graphToForm(useCanvasStore.getState().nodes) as unknown as ProjectFormInput,
		);
		setView("form");
	};

	const showCanvas = canvasEnabled && view === "canvas";

	return (
		<ConnectorsProvider connectors={connectors}>
			<RepositoryProvider>
				<FormProvider {...form}>
					{canvasEnabled && (
						<div className="mb-4 inline-flex border border-border">
							<button
								type="button"
								onClick={toForm}
								className={cn(
									"flex items-center gap-1.5 px-3 py-1.5 text-xs",
									view === "form"
										? "bg-foreground text-background"
										: "bg-background",
								)}
							>
								<FileText className="h-3.5 w-3.5" />
								Form
							</button>
							<button
								type="button"
								onClick={toCanvas}
								className={cn(
									"flex items-center gap-1.5 border-l border-border px-3 py-1.5 text-xs",
									view === "canvas"
										? "bg-foreground text-background"
										: "bg-background",
								)}
							>
								<LayoutGrid className="h-3.5 w-3.5" />
								Canvas
							</button>
						</div>
					)}

					{showCanvas ? (
						<DesignProjectCanvas
							cloudIdentities={cloudIdentities}
							onToggleForm={toForm}
						/>
					) : (
						<DesignProjectFormBody
							cloudIdentities={cloudIdentities}
							sourceProject={sourceProject}
						/>
					)}
				</FormProvider>
			</RepositoryProvider>
		</ConnectorsProvider>
	);
}
