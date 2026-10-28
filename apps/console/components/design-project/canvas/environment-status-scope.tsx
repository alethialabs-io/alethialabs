"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { EMPTY_ENVIRONMENT_STATUS } from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import { useEnvironmentStatusQuery } from "@/lib/query/use-environment-status-query";

/**
 * Whether a read failed with the typed FORBIDDEN refusal (`lib/rpc/base.ts`). Read structurally —
 * a DEFINED oRPC error carries `defined: true` and its `code` — so this file needs no `@orpc/*`
 * import (ADR 0005 §10 keeps those inside `lib/rpc/`).
 */
function isForbiddenRefusal(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	return Reflect.get(error, "defined") === true && Reflect.get(error, "code") === "FORBIDDEN";
}

/**
 * How the environment-status read stands, for the one place on the board that says so. `failed`
 * and `forbidden` are only ever set when there is NO status to show: a refetch that fails behind a
 * status already on screen keeps the last good answer, as every query here does.
 */
export interface EnvironmentStatusLoad {
	/** The read failed and there is no status to fall back on. */
	failed: boolean;
	/** The read was refused (403) — the viewer may not see this environment's status. */
	forbidden: boolean;
	/** Run the read again. */
	retry: () => void;
}

const NOT_FAILED: EnvironmentStatusLoad = { failed: false, forbidden: false, retry: () => {} };

const EnvironmentStatusLoadContext = createContext<EnvironmentStatusLoad>(NOT_FAILED);

/** The board's environment-status read state (see {@link EnvironmentStatusLoad}). */
export function useEnvironmentStatusLoad(): EnvironmentStatusLoad {
	return useContext(EnvironmentStatusLoadContext);
}

/**
 * Owns the ONE environment-status read the board makes and publishes it to every node through
 * `EnvironmentStatusProvider` — forty cards each running their own query would be forty round-trips.
 *
 * It lives with the canvas, not the project shell (#6119): only the board and its rail read it, and
 * the shell is a layout, which never receives the `?environment_id=` the read is keyed on — so the
 * shell's read could not be prefetched under the key the client asked for. Here it reads the
 * environment the Architecture page resolved and prefetched, so its first render HAS the status.
 *
 * Outside a project (the create flow) the read is disabled and the status is the empty one.
 */
export function EnvironmentStatusScope({
	projectId,
	environmentId,
	children,
}: {
	projectId: string | undefined;
	environmentId: string | undefined;
	children: ReactNode;
}) {
	const query = useEnvironmentStatusQuery(projectId, environmentId ?? null);
	const { data, error, refetch } = query;
	// How the read stands, for anything that must wait for it to SETTLE — the release gate's
	// project-route check holds the page until this is `success` or `error`. `idle` outside a project.
	const state = !projectId ? "idle" : data !== undefined ? "success" : error !== null ? "error" : "pending";
	const load = useMemo<EnvironmentStatusLoad>(() => {
		if (data !== undefined || error === null) return NOT_FAILED;
		return {
			failed: true,
			forbidden: isForbiddenRefusal(error),
			retry: () => void refetch(),
		};
	}, [data, error, refetch]);

	return (
		<EnvironmentStatusLoadContext.Provider value={load}>
			<span hidden data-slot="environment-status" data-state={state} />
			<EnvironmentStatusProvider value={data ?? EMPTY_ENVIRONMENT_STATUS}>
				{children}
			</EnvironmentStatusProvider>
		</EnvironmentStatusLoadContext.Provider>
	);
}
