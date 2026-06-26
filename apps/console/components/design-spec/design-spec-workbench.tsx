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
	specFormSchema,
	type SpecFormData,
	type SpecFormInput,
} from "@/lib/validations/spec-form.schema";
import { DesignSpecCanvas } from "./canvas/design-spec-canvas";
import { formToGraph } from "./canvas/graph/form-to-graph";
import { graphToForm } from "./canvas/graph/graph-to-form";
import { ConnectorsProvider } from "./connectors-context";
import {
	buildDefaultFormValues,
	DesignSpecFormBody,
	type SourceSpecData,
} from "./design-spec-form";
import { RepositoryProvider } from "./repository-context";

interface DesignSpecWorkbenchProps {
	cloudIdentities: CloudIdentityOption[];
	connectors?: ConnectorWithConnection[];
	sourceSpec?: SourceSpecData;
	/** Gates the canvas view; when false only the form renders (zero behavior change). */
	canvasEnabled: boolean;
}

type View = "form" | "canvas";

/**
 * Hosts both the form and the canvas over ONE shared RHF form instance. The
 * Canvas⇄Form toggle bridges the two representations on switch (form→canvas seeds
 * the canvas store; canvas→form resets the form from the graph).
 */
export function DesignSpecWorkbench({
	cloudIdentities,
	connectors = [],
	sourceSpec,
	canvasEnabled,
}: DesignSpecWorkbenchProps) {
	const [view, setView] = useState<View>("form");

	const form = useForm<SpecFormInput, unknown, SpecFormData>({
		resolver: zodResolver(specFormSchema),
		defaultValues: buildDefaultFormValues(sourceSpec),
		mode: "onChange",
	});

	// Seed the canvas store. Identities are always refreshed; the graph is seeded
	// only when duplicating (sourceSpec) or when the store is pristine — otherwise a
	// persisted sessionStorage draft is preserved across reloads/navigation.
	useEffect(() => {
		const store = useCanvasStore.getState();
		store.setIdentities(cloudIdentities);
		const project = store.nodes.find((n) => n.id === PROJECT_NODE_ID);
		const pristine =
			store.nodes.length <= 1 && !project?.data.config.project_name;
		if (sourceSpec || pristine) {
			store.setGraph(
				formToGraph(buildDefaultFormValues(sourceSpec), cloudIdentities),
			);
		}
	}, [cloudIdentities, sourceSpec]);

	const toCanvas = () => {
		useCanvasStore
			.getState()
			.setGraph(formToGraph(form.getValues() as SpecFormData, cloudIdentities));
		setView("canvas");
	};

	const toForm = () => {
		form.reset(
			graphToForm(useCanvasStore.getState().nodes) as unknown as SpecFormInput,
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
						<DesignSpecCanvas
							cloudIdentities={cloudIdentities}
							onToggleForm={toForm}
						/>
					) : (
						<DesignSpecFormBody
							cloudIdentities={cloudIdentities}
							sourceSpec={sourceSpec}
						/>
					)}
				</FormProvider>
			</RepositoryProvider>
		</ConnectorsProvider>
	);
}
