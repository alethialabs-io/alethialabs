// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { os } from "@orpc/server";
import { z } from "zod";
import { ActionRefusal } from "@/lib/actions/result";
import { UnauthorizedError } from "@/lib/auth/errors";
import { runWithActor } from "@/lib/authz/actor-context";
import { ForbiddenError } from "@/lib/authz/types";
import { errorDigest } from "@/lib/errors";
import type { RpcContext } from "@/lib/rpc/context";

/**
 * The read-side refusals (ADR 0005 §10 R11, #6113). An EXPECTED refusal is a typed oRPC error the
 * browser receives with its code — `isDefinedError(error) && error.code === "FORBIDDEN"` — so a
 * page can render forbidden, not-found or a plan gate distinctly from empty data and from a real
 * failure (RUBRIC B4: error ≠ empty ≠ endless skeleton). Anything not mapped here is an unexpected
 * error: oRPC answers 500 without its message.
 */
const refusals = {
	UNAUTHORIZED: { status: 401, message: "Sign in to see this." },
	FORBIDDEN: { status: 403, message: "You don't have permission to see this." },
	NOT_FOUND: { status: 404, message: "Not found." },
	CONFLICT: { status: 409, message: "This changed while you were looking at it." },
	ENTITLEMENT_REQUIRED: {
		status: 402,
		message: "Your plan does not include this.",
		data: z.object({ feature: z.string() }),
	},
};

/**
 * The builder every read procedure starts from (ADR 0005 D1, #6113).
 *
 * GET, always: oRPC 1.x enables `StrictGetMethodPlugin` by default, so a procedure must declare
 * GET to be served over GET — and a read served over POST is what made the console's reads queue
 * behind each other as server actions (F001). Mutations stay server actions (ADR D4): oRPC 1.x has
 * no CSRF protection for non-GET procedures, so this router carries reads only.
 *
 * The middleware turns the codebase's own refusal signals — a PDP `ForbiddenError`, a missing
 * session, Next's `notFound()`, a deliberate `ActionRefusal` — into the typed refusals above, so an
 * existing reader called in-process needs no change to refuse correctly over the wire.
 *
 * It also BINDS `context.actor` for the procedure (`runWithActor`), so a reader's own
 * `authorize()` / `currentActor()` answers with the actor the entry point resolved instead of
 * resolving a second time. The route handler already bound it; the in-process server caller
 * (`lib/rpc/server.ts`) bound nothing, so its context was computed and then unused — a context
 * built from the SESSION would have gone unnoticed (#6113 review, mutation 3). Both entry points now
 * serve from the actor they resolved, and `tests/integration/rpc-tenancy.*.test.ts` measures it.
 */
export const query = os
	.$context<RpcContext>()
	.errors(refusals)
	.use(async ({ next, errors, context }) => {
		try {
			return await runWithActor(context.actor, async () => next());
		} catch (error) {
			if (error instanceof ForbiddenError) throw errors.FORBIDDEN();
			if (error instanceof UnauthorizedError) throw errors.UNAUTHORIZED();
			if ((errorDigest(error) ?? "").startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) throw errors.NOT_FOUND();
			if (error instanceof ActionRefusal) {
				if (error.kind === "not-found") throw errors.NOT_FOUND({ message: error.message });
				if (error.kind === "conflict") throw errors.CONFLICT({ message: error.message });
				throw errors.ENTITLEMENT_REQUIRED({ message: error.message, data: { feature: error.feature ?? "" } });
			}
			throw error;
		}
	})
	.route({ method: "GET" });
