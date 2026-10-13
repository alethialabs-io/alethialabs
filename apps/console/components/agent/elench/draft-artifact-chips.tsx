"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LayoutDashboard } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";

/** Reads an artifact's name by id; null when the viewer cannot read it (or it is gone). */
export type ArtifactNameResolver = (artifactId: string) => Promise<string | null>;

/**
 * How the chips of the conversation's composer name their artifacts. The conversation provides it;
 * without a provider every chip says "Artifact".
 */
export const ArtifactNameContext = createContext<ArtifactNameResolver | null>(null);

/** What a chip says while its name is being read, or when it cannot be read. */
const UNNAMED = "Artifact";

/**
 * The artifacts a draft will place on its conversation's grid when its first message is sent
 * (ADR 0001 D3, D12), shown above the box. The ids are the draft's own content, so the chips come
 * back with the draft after a reload; each name is read through `ArtifactNameContext`.
 */
export function DraftArtifactChips({ artifactIds }: { artifactIds: readonly string[] }) {
	if (artifactIds.length === 0) return null;
	return (
		<ul aria-label="Attached artifacts" className="flex flex-wrap gap-1.5 px-3 pt-2.5">
			{artifactIds.map((id) => (
				<ArtifactChip key={id} artifactId={id} />
			))}
		</ul>
	);
}

/** One attached artifact: its icon and its name. */
function ArtifactChip({ artifactId }: { artifactId: string }) {
	const resolveName = useContext(ArtifactNameContext);
	const [named, setNamed] = useState<{ id: string; name: string | null } | null>(null);
	useEffect(() => {
		if (resolveName === null) return;
		let live = true;
		resolveName(artifactId)
			.then((name) => {
				if (live) setNamed({ id: artifactId, name });
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [artifactId, resolveName]);
	const name = named !== null && named.id === artifactId ? named.name : null;
	return (
		<li className="flex max-w-full items-center gap-1.5 border border-border bg-muted px-2 py-1 text-ui-xs text-foreground">
			<LayoutDashboard aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="truncate">{name ?? UNNAMED}</span>
		</li>
	);
}
