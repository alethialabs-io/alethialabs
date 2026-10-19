// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { os } from "@orpc/server";
import type { RpcContext } from "@/lib/rpc/context";

/**
 * The builder every read procedure starts from (ADR 0005 D1, #6113).
 *
 * GET, always: oRPC 1.x enables `StrictGetMethodPlugin` by default, so a procedure must declare
 * GET to be served over GET — and a read served over POST is what made the console's reads queue
 * behind each other as server actions (F001). Mutations stay server actions (ADR D4): oRPC 1.x has
 * no CSRF protection for non-GET procedures, so this router carries reads only.
 */
export const query = os.$context<RpcContext>().route({ method: "GET" });
