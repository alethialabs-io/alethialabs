"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project workspace shell: a full-bleed flex row with the routed view on the left and the
// docked panel on the right. Because the dock lives in this LAYOUT (not the routed page), the AI
// assistant stays open as you switch views (Architecture / Environments / Jobs / …). The service
// inspector is canvas-only and is cleared when you leave Architecture.

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { destroyProject } from "@/app/server/actions/projects";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import {
	CanvasDock,
	useDockState,
} from "@/components/design-project/canvas/canvas-dock";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { cn } from "@repo/ui/utils";

export function ProjectShell({
	projectId,
	identities,
	children,
}: {
	projectId: string;
	identities: CloudIdentityOption[];
	children: React.ReactNode;
}) {
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const openInspector = useCanvasStore((s) => s.openInspector);
	const inspectorNodeId = useCanvasStore((s) => s.inspectorNodeId);

	// Architecture is the only env-scoped design surface; the inspector belongs to it alone.
	const onArchitecture = pathname.endsWith("/architecture");
	const dock = useDockState(onArchitecture);

	// Leaving Architecture closes the canvas-only inspector (the assistant stays open).
	useEffect(() => {
		if (!onArchitecture && inspectorNodeId) openInspector(null);
	}, [onArchitecture, inspectorNodeId, openInspector]);

	/** Tear down the active environment (queued from the Project settings inspector). */
	const handleDestroy = async () => {
		try {
			const envId = searchParams.get("environment_id") ?? undefined;
			const activeEnvId = await resolveActiveEnvironmentId(projectId, envId);
			await destroyProject(projectId, activeEnvId);
			toast.success("Destroy queued");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to destroy");
		}
	};

	return (
		<div className="-m-4 flex h-[calc(100dvh-3.5rem)] sm:-m-6 lg:-m-8 xl:-m-10">
			<div
				className={cn(
					"relative min-w-0 flex-1",
					dock && "border-r border-border",
				)}
			>
				{/* Architecture fills the board full-bleed; other views scroll with padding. */}
				{onArchitecture ? (
					<div className="h-full">{children}</div>
				) : (
					<div className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8 xl:p-10">
						{children}
					</div>
				)}
			</div>

			<CanvasDock
				dock={dock}
				projectId={projectId}
				identities={identities}
				onDestroyEnvironment={handleDestroy}
			/>
		</div>
	);
}
