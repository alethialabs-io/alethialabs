"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { asc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { artifactSpecSchema } from "@/lib/ai/artifact-spec";
import { requireOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";
import { type AgentArtifact, agentArtifacts, threadWidgets } from "@/lib/db/schema";
import type { ArtifactSpec } from "@/types/jsonb.types";

const nameSchema = z.string().min(1).max(80);
const kindSchema = z.enum(["widget", "dashboard"]);

/** Save a new named, org-scoped artifact (fails on a duplicate name in the org). */
export async function saveArtifact(
	name: string,
	kind: "widget" | "dashboard",
	spec: ArtifactSpec,
): Promise<AgentArtifact> {
	const parsedName = nameSchema.parse(name.trim());
	const parsedKind = kindSchema.parse(kind);
	const parsedSpec = artifactSpecSchema.parse(spec);
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const [row] = await tx
			.insert(agentArtifacts)
			.values({
				user_id: owner,
				org_id: owner,
				name: parsedName,
				kind: parsedKind,
				spec: parsedSpec,
			})
			.returning();
		return row;
	});
}

/** List the org's artifacts, alphabetical. */
export async function listArtifacts(): Promise<AgentArtifact[]> {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) =>
		tx.select().from(agentArtifacts).orderBy(asc(agentArtifacts.name)),
	);
}

/** Load one artifact by id or exact name (RLS scopes to the org). */
export async function getArtifact(idOrName: string): Promise<AgentArtifact | null> {
	const owner = await requireOwner();
	const isUuid = z.string().uuid().safeParse(idOrName).success;
	return withOwnerScope(owner, async (tx) => {
		const [row] = await tx
			.select()
			.from(agentArtifacts)
			.where(
				isUuid
					? or(eq(agentArtifacts.id, idOrName), eq(agentArtifacts.name, idOrName))
					: eq(agentArtifacts.name, idOrName),
			)
			.limit(1);
		return row ?? null;
	});
}

/** Replace an artifact's spec (agent `update_artifact` and manual re-saves). */
export async function updateArtifact(
	id: string,
	spec: ArtifactSpec,
): Promise<AgentArtifact | null> {
	const parsedId = z.string().uuid().parse(id);
	const parsedSpec = artifactSpecSchema.parse(spec);
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		const [row] = await tx
			.update(agentArtifacts)
			.set({ spec: parsedSpec, updated_at: sql`now()` })
			.where(eq(agentArtifacts.id, parsedId))
			.returning();
		return row ?? null;
	});
}

/** Delete an artifact (open widgets keep rendering; their artifact_id nulls out). */
export async function deleteArtifact(id: string): Promise<void> {
	const parsedId = z.string().uuid().parse(id);
	const owner = await requireOwner();
	await withOwnerScope(owner, async (tx) => {
		await tx.delete(agentArtifacts).where(eq(agentArtifacts.id, parsedId));
	});
}

/**
 * Materialize an artifact onto a thread's grid: fresh thread_widgets rows carrying
 * `artifact_id` (so agent edits sync), positions shifted below the grid's current
 * lowest row to avoid collisions.
 */
export async function openArtifactOnGrid(
	artifactId: string,
	threadId: string,
): Promise<void> {
	const parsedArtifact = z.string().uuid().parse(artifactId);
	const parsedThread = z.string().uuid().parse(threadId);
	const owner = await requireOwner();
	await withOwnerScope(owner, async (tx) => {
		const [artifact] = await tx
			.select()
			.from(agentArtifacts)
			.where(eq(agentArtifacts.id, parsedArtifact))
			.limit(1);
		if (!artifact) return;
		const existing = await tx
			.select({ pos_y: threadWidgets.pos_y, rowspan: threadWidgets.rowspan })
			.from(threadWidgets)
			.where(eq(threadWidgets.thread_id, parsedThread));
		const yOffset = existing.reduce((m, w) => Math.max(m, w.pos_y + w.rowspan), 0);
		for (const w of artifact.spec.widgets) {
			await tx.insert(threadWidgets).values({
				thread_id: parsedThread,
				user_id: owner,
				org_id: owner,
				kind: w.kind,
				title: w.title,
				source: w.source,
				data: w.data,
				pos_x: w.position.x,
				pos_y: w.position.y + yOffset,
				colspan: w.size.colspan,
				rowspan: w.size.rowspan,
				mode: w.mode,
				artifact_id: artifact.id,
			});
		}
	});
}

/**
 * Sync an artifact's latest spec onto every open widget of a thread that carries its
 * artifact_id — called by the client after an agent `update_artifact` so the grid
 * reflects the edit. Simple strategy: replace those rows with the new spec (same
 * y-anchor: the minimum row of the replaced set).
 */
export async function syncArtifactWidgets(
	artifactId: string,
	threadId: string,
): Promise<void> {
	const parsedArtifact = z.string().uuid().parse(artifactId);
	const parsedThread = z.string().uuid().parse(threadId);
	const owner = await requireOwner();
	await withOwnerScope(owner, async (tx) => {
		const [artifact] = await tx
			.select()
			.from(agentArtifacts)
			.where(eq(agentArtifacts.id, parsedArtifact))
			.limit(1);
		if (!artifact) return;
		const rows = await tx
			.select({ id: threadWidgets.id, pos_y: threadWidgets.pos_y })
			.from(threadWidgets)
			.where(eq(threadWidgets.thread_id, parsedThread));
		const linked = await tx
			.select({
				id: threadWidgets.id,
				pos_y: threadWidgets.pos_y,
				updated_at: threadWidgets.updated_at,
			})
			.from(threadWidgets)
			.where(eq(threadWidgets.artifact_id, parsedArtifact));
		const linkedInThread = linked.filter((l) => rows.some((r) => r.id === l.id));
		if (linkedInThread.length === 0) return;
		// Replays are no-ops: only sync when the artifact was edited AFTER the widgets
		// were last written (fresh inserts below stamp updated_at past the artifact's).
		const newestWidget = linkedInThread.reduce(
			(m, l) => (l.updated_at > m ? l.updated_at : m),
			new Date(0),
		);
		if (artifact.updated_at <= newestWidget) return;
		const anchor = Math.min(...linkedInThread.map((l) => l.pos_y));
		for (const l of linkedInThread) {
			await tx.delete(threadWidgets).where(eq(threadWidgets.id, l.id));
		}
		for (const w of artifact.spec.widgets) {
			await tx.insert(threadWidgets).values({
				thread_id: parsedThread,
				user_id: owner,
				org_id: owner,
				kind: w.kind,
				title: w.title,
				source: w.source,
				data: w.data,
				pos_x: w.position.x,
				pos_y: w.position.y + anchor,
				colspan: w.size.colspan,
				rowspan: w.size.rowspan,
				mode: w.mode,
				artifact_id: artifact.id,
			});
		}
	});
}
