"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The reads the token sheets share. The picker's environments are read ONCE for every project of the
// org (`agents.tokenEnvironments` with no project limit) and narrowed here to the token's projects,
// so ticking a project in the create sheet re-renders rather than re-fetches.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { TokenProjectChoices } from "@/lib/agents/service-tokens";
import { orpc } from "@/lib/rpc/client";
import { retryUnlessRefused } from "@/lib/rpc/refusal";
import type { PickerChoices } from "./auto-approve-picker";

/** Every query key the token writes change: the list. Invalidated after each write. */
export const SERVICE_TOKEN_READS = [orpc.agents.serviceTokens.key()];

/** The org's projects that have environments, in name order — what "Only these projects" offers. */
interface TokenProjectOption {
	id: string;
	name: string;
}

/** What {@link useTokenEnvironments} answers. */
export interface TokenEnvironmentsRead {
	choices: PickerChoices;
	/** Null until the read lands. */
	projects: TokenProjectOption[] | null;
}

/**
 * The picker's environment choices narrowed to `projectIds` (null = every project), plus the
 * project options the create sheet's project chooser lists. `enabled: false` holds the read while
 * its sheet is closed.
 */
export function useTokenEnvironments(
	projectIds: readonly string[] | null,
	enabled: boolean,
): TokenEnvironmentsRead {
	const read = useQuery(
		orpc.agents.tokenEnvironments.queryOptions({ input: {}, enabled, retry: retryUnlessRefused }),
	);
	const { data, isError, refetch } = read;
	return useMemo((): TokenEnvironmentsRead => {
		if (data === undefined) {
			return {
				choices: isError ? { state: "error", retry: () => void refetch() } : { state: "loading" },
				projects: null,
			};
		}
		const all: TokenProjectChoices[] = data;
		const allowed = projectIds ? new Set(projectIds) : null;
		return {
			choices: { state: "ready", projects: allowed ? all.filter((p) => allowed.has(p.projectId)) : all },
			projects: all.map((p) => ({ id: p.projectId, name: p.projectName })),
		};
	}, [data, isError, refetch, projectIds]);
}

/** The environment ids of `choices` a token may auto-approve: non-production ones only. */
export function autoApprovableIds(choices: PickerChoices): Set<string> {
	if (choices.state !== "ready") return new Set();
	return new Set(
		choices.projects.flatMap((p) => p.environments.filter((e) => e.stage !== "production").map((e) => e.id)),
	);
}
