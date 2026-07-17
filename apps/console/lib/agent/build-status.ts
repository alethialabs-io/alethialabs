// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W2: derive per-service image-build state for the artifact panel's Build tab. A repo-sourced service
// builds an image in an in-cluster kaniko BUILD job whose result lands on `execution_metadata.build_result`
// (service → digest) and is persisted to `project_services.resolved_image`. There is no per-service status
// column — the phase is DERIVED from (job status × whether the digest has landed), so the surface can't
// drift from the actual read model. Image-sourced services don't build (they deploy a prebuilt image).

import type { ProvisionJobStatus } from "@/lib/db/schema/enums";
import type { ServiceSource } from "@/types/jsonb.types";

export type BuildPhase =
	| "queued"
	| "building"
	| "pushed"
	| "failed"
	| "not-built";

/** One repo-sourced service's build state. */
export interface BuildServiceState {
	name: string;
	phase: BuildPhase;
	/** The resolved image digest URI, once pushed. */
	image: string | null;
}

/** The minimal service shape the derivation reads (a subset of the persisted service row). */
export interface BuildServiceInput {
	name: string;
	source: ServiceSource;
	resolved_image?: string | null;
}

/** The open BUILD job's live state, when a BUILD job is the artifact. `null` → read the persisted
 * `resolved_image` (the last successful build) instead. */
export interface BuildJobState {
	status: ProvisionJobStatus;
	/** execution_metadata.build_result — service name → pushed image digest. */
	buildResult: Record<string, string>;
}

/**
 * Per repo-sourced service, its build phase + resolved image. When a BUILD job is open the phase reads
 * from (job status × digest presence); otherwise from the persisted `resolved_image`. Image-sourced
 * services are excluded — they carry no build.
 */
export function deriveBuildStates(
	services: BuildServiceInput[],
	build: BuildJobState | null,
): BuildServiceState[] {
	return services
		.filter((s) => s.source.kind === "repo")
		.map((s) => {
			const digestFromJob = build?.buildResult[s.name];
			const image = digestFromJob ?? s.resolved_image ?? null;

			let phase: BuildPhase;
			if (digestFromJob) {
				phase = "pushed";
			} else if (!build) {
				// No live build — the persisted digest is the whole truth.
				phase = image ? "pushed" : "not-built";
			} else {
				switch (build.status) {
					case "QUEUED":
						phase = "queued";
						break;
					case "CLAIMED":
					case "PROCESSING":
						phase = "building";
						break;
					case "FAILED":
					case "CANCELLED":
						phase = "failed";
						break;
					case "SUCCESS":
						// Job done but this service has no digest → the persisted image, else an honest
						// "not built" rather than a fabricated success.
						phase = image ? "pushed" : "not-built";
						break;
				}
			}
			return { name: s.name, phase, image };
		});
}

/** How many services deploy a prebuilt image (not built) — for the pane's honest footnote. */
export function prebuiltImageCount(services: BuildServiceInput[]): number {
	return services.filter((s) => s.source.kind === "image").length;
}
