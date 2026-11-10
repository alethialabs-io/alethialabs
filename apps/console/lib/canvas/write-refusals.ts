// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE CANVAS WRITES' REFUSALS, ON THE MUTATION CONTRACT (ADR 0005 §D4, #6119).
//
// The board's writes (add-ons, BYO charts and IaC, the Run menu, save / deploy / discard / destroy)
// run functions that other callers share — the CLI routes, the assistant's tools — and those keep
// their own shapes: some THROW a sentence, some RETURN `{ ok: false, error }`. `defineAction` only
// shows a refusal it can recognise; any other throw becomes `unexpected` with a reference, which is
// right for a defect and wrong for "a probe is already running". These two adapters are where the
// canvas actions say which failures are a person's to act on. Nothing else is mapped: an unknown
// error stays an unexpected one, so its text never reaches the browser.

import "server-only";

import { ActionRefusal, FieldRefusal } from "@/lib/actions/result";
import { UsageLimitError } from "@/lib/billing/usage-guard";
import { ProjectOrgRefusalError } from "@/lib/projects/refuse-other-org";

/**
 * What `resolveActiveEnvironmentId` (app/server/actions/resolve.ts) throws when the project has no
 * environment the actor can resolve — another org's project included. Read by the GET procedures
 * too (`lib/rpc/procedures/canvas.ts`), so the one sentence is matched in one place.
 */
export const NO_DEFAULT_ENVIRONMENT = "Project has no default environment";

/** The feature an upgradable job-cap refusal names, so the caller's upgrade surface knows what lifts it. */
const JOB_QUOTA_FEATURE = "jobQuota";

/**
 * Runs a canvas write's body and rethrows the refusals a person can act on as `ActionRefusal`s:
 * the plan's job cap (an entitlement when upgrading lifts it), a project of another org, and an
 * environment that does not resolve for this actor (`not-found` — never a different tenant's).
 */
export async function refusingCanvasWrite<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		// Already a refusal with its kind (the body raised it on purpose): pass it through untouched.
		if (error instanceof ActionRefusal || error instanceof FieldRefusal) throw error;
		if (error instanceof UsageLimitError) {
			throw error.upgradable
				? new ActionRefusal("entitlement", error.message, JOB_QUOTA_FEATURE)
				: new ActionRefusal("conflict", error.message);
		}
		if (error instanceof ProjectOrgRefusalError) {
			throw new ActionRefusal("conflict", error.message);
		}
		if (error instanceof Error && error.message === NO_DEFAULT_ENVIRONMENT) {
			throw new ActionRefusal("not-found", "Environment not found.");
		}
		throw error;
	}
}

/** The value-returned refusal several shared write functions answer with (#5445, #5454). */
export interface ReturnedRefusal {
	ok: false;
	error: string;
}

/**
 * Unwraps a write that RETURNS its refusal (`{ ok: false, error }`): a refusal becomes a `conflict`
 * whose sentence is shown verbatim, and a success is answered as it is. Thrown failures go through
 * {@link refusingCanvasWrite}.
 */
export async function returnedRefusalAsConflict<T extends { ok: true }>(
	run: () => Promise<T | ReturnedRefusal>,
): Promise<T> {
	const result = await refusingCanvasWrite(run);
	if (isReturnedRefusal(result)) throw new ActionRefusal("conflict", result.error);
	return result;
}

/** Whether a write's answer is its returned refusal rather than its success. */
function isReturnedRefusal<T extends { ok: true }>(
	result: T | ReturnedRefusal,
): result is ReturnedRefusal {
	return result.ok === false;
}
