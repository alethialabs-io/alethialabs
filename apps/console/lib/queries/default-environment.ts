// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The single-value "which environment does this project mean?" pick.
//
// Three readers used to answer it with `envs.find((e) => e.is_default) ?? envs[0]` — an arbitrary
// row presented as an answer, kept because the schema only guaranteed AT MOST one default. It now
// guarantees exactly one for any project that has environments
// (`project_environments_one_default_check`, lib/db/programmables.sql), so the fallback is no
// longer a defensive path: it is a place where a broken invariant would be laundered into a
// plausible-looking answer, and the CLI, the console header and the deploy target would each
// silently pick a DIFFERENT environment while every surface claimed to agree.
//
// So the guess is replaced by a report. "This project has no environments" stays a distinct,
// ordinary outcome (`null`) — it is a real state the callers already handle by name. "This project
// has environments but no default" is the invariant violation, and it throws.

/**
 * Thrown when a project's environments exist but none is flagged `is_default` — a state the
 * database refuses to commit, so reaching it means the constraint trigger is missing or disabled.
 */
export class MissingDefaultEnvironmentError extends Error {
	readonly projectId: string;

	constructor(projectId: string) {
		super(
			`Project ${projectId} has environments but none is the default. ` +
				"project_environments_one_default_check (lib/db/programmables.sql) should make this " +
				"unreachable — check that programmables.sql has been applied to this database.",
		);
		this.name = "MissingDefaultEnvironmentError";
		this.projectId = projectId;
	}
}

/**
 * Picks a project's default environment from an already-loaded list. Returns `null` when the
 * project has no environments; throws {@link MissingDefaultEnvironmentError} when it has some and
 * none is the default.
 */
export function pickDefaultEnvironment<T extends { is_default: boolean }>(
	projectId: string,
	environments: readonly T[],
): T | null {
	if (environments.length === 0) return null;
	const found = environments.find((e) => e.is_default);
	if (!found) throw new MissingDefaultEnvironmentError(projectId);
	return found;
}
