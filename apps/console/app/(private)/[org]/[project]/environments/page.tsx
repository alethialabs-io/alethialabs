// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import {
	getEnvConsistency,
	getProjectEnvironments,
} from "@/app/server/actions/projects";
import { listPromotions } from "@/app/server/actions/promotions";
import { getEnvReconcileStates } from "@/app/server/actions/reconcile";
import { resolveProjectId } from "@/app/server/actions/resolve";
import {
	EnvironmentsView,
	type EnvRow,
	type PromotionRowView,
} from "@/components/environments/environments-view";
import { pageMetadata } from "@/lib/seo/page-metadata";

export async function generateMetadata() {
	return pageMetadata({
		title: "Environments",
		description: "Isolated instances of this project's services.",
	});
}

/**
 * `/{org}/{project}/environments` — the project's Environments management view (in place of the
 * canvas). Lists every environment; create / duplicate / delete are handled in the client view.
 */
export default async function ProjectEnvironmentsPage({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { org, project } = await params;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}

	// The environments list is the core of the page and must always render. The three enrichment
	// probes (consistency / reconcile / promotions) each read per-env design and can throw (e.g. a
	// since-deleted cloud identity); they degrade to safe empty defaults rather than crashing the page.
	const { environments } = await getProjectEnvironments(projectId);
	const [consistency, reconcile, promotions] = await Promise.all([
		getEnvConsistency(projectId).catch(() => ({
			envs: environments.map((e) => ({ id: e.id, name: e.name, stage: e.stage })),
			rows: [],
		})),
		getEnvReconcileStates(projectId).catch(() => []),
		listPromotions(projectId).catch(() => []),
	]);
	const envs: EnvRow[] = environments.map((e) => ({
		id: e.id,
		name: e.name,
		stage: e.stage,
		is_default: e.is_default,
		updated_at: e.updated_at.toISOString(),
	}));
	const promotionRows: PromotionRowView[] = promotions.map((p) => ({
		id: p.id,
		source_environment_id: p.source_environment_id,
		target_environment_id: p.target_environment_id,
		status: p.status,
		error_message: p.error_message,
		created_at: p.created_at.toISOString(),
	}));

	return (
		<EnvironmentsView
			org={org}
			project={project}
			projectId={projectId}
			envs={envs}
			consistency={consistency}
			reconcile={reconcile}
			promotions={promotionRows}
		/>
	);
}
