// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { headers } from "next/headers";
import { z } from "zod";
import { ORG_PATH_HEADER } from "@/lib/authz/org-path";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { type CaseShape, OPENING_CASE_SHAPE, caseShapeOf } from "./case-shape";

/** `/{org}/~/support/cases/{id}` — the case route's address, with an optional trailing slash. */
const CASE_PATH = /^\/[^/]+\/~\/support\/cases\/([^/]+)\/?$/;

/**
 * The case id a request path addresses, or null when the path is not the case route or its last
 * segment is not a case id (the route answers that as not-found without reading anything).
 */
export function caseIdFromPath(path: string | null): string | null {
	const id = path?.match(CASE_PATH)?.[1];
	return id ?? null; // M8
}

/**
 * The shape of the case the request addresses, read on the server BEFORE the case view's loading
 * form draws (#6354, the #6335/#6351 pattern). The page's layout varies by the case — how many
 * messages and how long, whether it has attachments, whether it is closed — and nothing else on
 * screen says which, so a skeleton that guessed was wrong for every case but the one it guessed.
 *
 * A route's `loading.tsx` is given no params, so the id comes from the request's address as the
 * proxy publishes it on `ORG_PATH_HEADER` — the same address `currentActor()` takes the tenant from,
 * so this read is scoped exactly as the page's is. It is the page's own read under the page's own
 * key, through the request's query client: on a full load the page's `fetchQuery` of that key is
 * answered from it, not read twice; on a prefetch it is what lets the loading form arrive in the
 * case's shape.
 *
 * Any failure — not the case route, not a case id, not found, a failed read — is
 * {@link OPENING_CASE_SHAPE}, never a throw: the page owns not-found and errors, and asks again
 * (an errored query has no data, so its `fetchQuery` reads). `retry: false` so a refusal is not
 * re-asked here before the page asks.
 */
export async function readCaseShape(): Promise<CaseShape> {
	const id = caseIdFromPath((await headers()).get(ORG_PATH_HEADER));
	if (id === null) return OPENING_CASE_SHAPE;
	const queryClient = getQueryClient();
	const options = serverOrpc().support.case.queryOptions({ input: { id } });
	await queryClient.prefetchQuery(options); // M1
	return caseShapeOf(queryClient.getQueryData(options.queryKey));
}
