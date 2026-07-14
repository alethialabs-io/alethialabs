"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useState } from "react";
import { getProjects } from "@/app/server/actions/projects";
import { type ElenchCtx, useElenchStore } from "@/lib/stores/use-elench-store";

/** One selectable workspace in the rail — an infra project (the org workspace is implicit). */
export interface ElenchWorkspace {
	id: string;
	name: string;
	provider: string | null;
	status: string;
}

/**
 * The Elench workspace switcher, mirroring Claude's sidebar: a general **Chats** area (the org
 * assistant) plus the list of **Projects** you can step into. Selecting a project flips the store's
 * `ctx`, which by itself re-scopes everything that hangs off it — the thread list
 * (`listThreads(projectId)`), the Knowledge panel's row, the agent's memory namespace, and the
 * project tool-set. Without this, a project workspace was only reachable by opening Elench from
 * that project's page, so all of the per-project context was effectively invisible.
 */
export function useElenchWorkspaces() {
	const ctx = useElenchStore((s) => s.ctx);
	const open = useElenchStore((s) => s.open);
	const openModal = useElenchStore((s) => s.openModal);
	const [projects, setProjects] = useState<ElenchWorkspace[]>([]);

	// Load once per open — the rail is only shown in the modal, and project lists are small.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		void getProjects()
			.then((rows) => {
				if (cancelled) return;
				setProjects(
					rows.map((p) => ({
						id: p.id,
						name: p.project_name,
						provider: p.cloud_provider ?? null,
						status: p.status,
					})),
				);
			})
			.catch(() => {
				if (!cancelled) setProjects([]);
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	/** The project workspace we're in, or null for the general (org) assistant. */
	const activeProjectId = ctx.kind === "project" ? ctx.projectId : null;

	/**
	 * Step into a workspace. `openModal` already starts a fresh conversation when the context
	 * changes (org tools must not bleed into a project chat and vice-versa).
	 */
	const selectWorkspace = useCallback(
		(projectId: string | null) => {
			const next: ElenchCtx = projectId
				? { kind: "project", projectId }
				: { kind: "org" };
			openModal(next);
		},
		[openModal],
	);

	return { projects, activeProjectId, selectWorkspace };
}
