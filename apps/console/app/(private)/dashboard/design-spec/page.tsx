// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getSpecAsFormData } from "@/app/server/actions/specs";
import { DesignSpecForm } from "@/components/design-spec/design-spec-form";

interface DesignSpecPageProps {
	searchParams: Promise<{ source?: string }>;
}

export default async function DesignSpecPage({ searchParams }: DesignSpecPageProps) {
	const { source } = await searchParams;
	const identities = await getVerifiedCloudIdentities();

	let sourceSpec = undefined;
	if (source) {
		try {
			sourceSpec = await getSpecAsFormData(source);
		} catch {
			// Source spec not found or unauthorized — proceed without pre-population
		}
	}

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

			<DesignSpecForm cloudIdentities={identities} sourceSpec={sourceSpec} />
		</div>
	);
}
