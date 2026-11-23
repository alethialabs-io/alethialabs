"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which release of the platform this console is, said in the account menu beside the other
// instance facts (status, changelog, source): the commercial stage, the platform release name, and
// the short SHA of the build that is running.
//
// The stage is `RELEASE_STAGE` from `@repo/legal/launch` (EA-4, #7326) — the one name every
// surface prints, so this line cannot disagree with the pricing page. It is not re-declared here.
//
// The SHA is the one the console already exposes: the image's `runner` stage sets
// NEXT_PUBLIC_APP_VERSION to the deploy commit (`apps/console/Dockerfile`), `/api/health` reports it
// as `build`, and production QA records quote it from `window.__ENV`. It is read with
// `env("NEXT_PUBLIC_APP_VERSION")`, written out literally, because
// `tests/unit/dockerfile-runtime-public-env.test.ts` finds runtime reads by that exact form.
//
// A build value is shown only when it has the shape of a commit or a version tag; anything else is
// left out rather than printed, so this line can never carry an arbitrary configured string.
//
// `versionFacts` is pure and takes the build value, so every case is unit tested
// (`tests/components/shell/version-label.test.tsx`). `VersionLabel` reads the value.

import { RELEASE_STAGE } from "@repo/legal/launch";
import { env } from "next-runtime-env";

/**
 * The platform release name: one name for the console, CLI and runner of this release. Whether it
 * keeps its name now that the stage reads `RELEASE_STAGE` is the maintainer's call (EA-4).
 */
export const PLATFORM_RELEASE = "2027.01-beta";

/** A full or abbreviated git commit SHA. */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

/** A version tag or a plain build word such as `dev` or `v0.6.2`. */
const VERSION_TAG = /^v?[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;

/** How many characters of a commit SHA are shown. */
const SHORT_SHA_LENGTH = 7;

/** What the version line says. `build` is null when the running build is not known. */
export interface VersionFacts {
	/** The commercial stage, `RELEASE_STAGE`. */
	stage: string;
	/** The platform release name. */
	release: string;
	/** The short SHA or version tag of the running build, or null. */
	build: string | null;
	/** The full commit SHA, when the build is a commit; offered as the line's tooltip. */
	commit: string | null;
}

/**
 * The version line's facts for a build value: a commit SHA is shortened to seven characters, a
 * version tag is shown as it is, and an absent, empty or unrecognised value shows no build.
 */
export function versionFacts(buildValue: string | undefined): VersionFacts {
	const value = buildValue?.trim() ?? "";
	const base = { stage: RELEASE_STAGE, release: PLATFORM_RELEASE };
	if (COMMIT_SHA.test(value)) {
		return { ...base, build: value.slice(0, SHORT_SHA_LENGTH).toLowerCase(), commit: value.toLowerCase() };
	}
	if (VERSION_TAG.test(value)) return { ...base, build: value, commit: null };
	return { ...base, build: null, commit: null };
}

/**
 * The account menu's version line: the stage (upper-cased by CSS), the release name and the short
 * build, e.g. "<stage> · 2027.01-beta · 703d40d". Not interactive.
 */
export function VersionLabel() {
	const facts = versionFacts(env("NEXT_PUBLIC_APP_VERSION"));
	return (
		<p
			data-slot="version-label"
			title={facts.commit ?? undefined}
			className="flex min-w-0 items-center gap-1.5 px-2 py-1.5 font-mono text-ui-2xs text-muted-foreground"
		>
			<span className="uppercase tracking-wider text-foreground">{facts.stage}</span>
			<span aria-hidden="true">·</span>
			<span className="truncate">{facts.release}</span>
			{facts.build !== null && (
				<>
					<span aria-hidden="true">·</span>
					<span className="sr-only">build </span>
					<span className="truncate">{facts.build}</span>
				</>
			)}
		</p>
	);
}
