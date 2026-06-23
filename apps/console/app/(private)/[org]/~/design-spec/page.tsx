// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getConnectorsWithStatus } from "@/app/server/actions/connectors";
import { getScanProposal } from "@/app/server/actions/scanner";
import { getSpecAsFormData } from "@/app/server/actions/specs";
import { DesignSpecWorkbench } from "@/components/design-spec/design-spec-workbench";

interface DesignSpecPageProps {
	searchParams: Promise<{ source?: string; scan?: string }>;
}

export default async function DesignSpecPage({ searchParams }: DesignSpecPageProps) {
	const { source, scan } = await searchParams;
	const [identities, connectors] = await Promise.all([
		getVerifiedCloudIdentities(),
		getConnectorsWithStatus(),
	]);

	let sourceSpec: Awaited<ReturnType<typeof getSpecAsFormData>> | undefined;
	if (source) {
		try {
			sourceSpec = await getSpecAsFormData(source);
		} catch {
			// Source spec not found or unauthorized — proceed without pre-population
		}
	} else if (scan) {
		// Repo-analyzer handoff: open the scanner's proposed spec for review.
		try {
			const res = await getScanProposal(scan);
			if (res.status === "READY") {
				const p = res.proposal.provider;
				sourceSpec = {
					formData: res.proposal.proposedSpec,
					provider: p === "gcp" || p === "azure" ? p : "aws",
				};
			}
		} catch {
			// Scan not ready / unauthorized — proceed without pre-population
		}
	}

	// Canvas is gated during rollout; when off the workbench renders only the form.
	const canvasEnabled = process.env.NEXT_PUBLIC_CANVAS_ENABLED === "true";

	return (
		<div className="w-full space-y-6">
			<div className="space-y-1.5">
				<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
					{sourceSpec ? "Duplicate & Edit" : "Create a Spec"}
				</h1>
				<p className="text-muted-foreground text-sm">
					{sourceSpec
						? "Review and edit the converted spec before creating."
						: "Configure your infrastructure components. Each section maps to a resource in your cloud account."}
				</p>
			</div>

			<DesignSpecWorkbench
				cloudIdentities={identities}
				connectors={connectors}
				sourceSpec={sourceSpec}
				canvasEnabled={canvasEnabled}
			/>
		</div>
	);
}
