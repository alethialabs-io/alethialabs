// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { NextResponse } from "next/server";

/**
 * The server half of the CLI version handshake (cli-finish spec §4.5, unit CLI-L11a).
 *
 * The CLI names its build on every request with `X-Alethia-CLI-Version: <v>` and
 * `User-Agent: alethia-cli/<v> (<os>; <arch>)` (`packages/core/api/transport.go`,
 * `setClientHeaders`). This module reads that version and decides one thing: is it below the minimum
 * the operator configured in `ALETHIA_MIN_CLI_VERSION`? Only then is the request refused, with a 426
 * whose body carries `code: "cli_too_old"` — the code the CLI maps to exit 14.
 *
 * Every other case is let through, on purpose:
 * - no minimum configured, or one that does not parse — the default, and what a self-hosted install
 *   gets until its operator sets one;
 * - no version header at all — a CLI older than the headers, a script, curl;
 * - a version that does not parse — a local `dev` build.
 * An unparseable value is not evidence of an old CLI, so it never earns a refusal.
 */

/** The request header the CLI names its build in. */
export const CLI_VERSION_HEADER = "x-alethia-cli-version";

/** The response header that names the configured minimum, when there is one. */
export const CLI_MIN_VERSION_HEADER = "x-alethia-min-cli";

/**
 * The header that carries a CLI request's id, on the response and on the request the route handler
 * sees. The CLI reads it from the response (`packages/core/api/api.go`, `responseError`) and prints it
 * beside an error, so a support conversation can find the request in the logs.
 */
export const CLI_REQUEST_ID_HEADER = "x-request-id";

/**
 * Mints a request id: `req_` and 32 hex digits of a random UUID. It is generated here and never
 * derived from the request — an inbound `X-Request-Id` is ignored and overwritten — so an id cannot
 * carry anything the caller sent, and it names nothing about the account or the route.
 */
export function newCliRequestId(): string {
	return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** True for the CLI API's paths: `/api/cli` and everything under it. */
export function isCliApiPath(path: string): boolean {
	return path === "/api/cli" || path.startsWith("/api/cli/");
}

/** The stable error code the CLI classifies a refusal by. */
export const CLI_TOO_OLD_CODE = "cli_too_old";

/** A parsed `major.minor.patch[-prerelease]` version. */
export interface CliVersion {
	major: number;
	minor: number;
	patch: number;
	/** The pre-release tag (`rc.1`), or null for a release build. */
	prerelease: string | null;
}

/**
 * Anchored on both ends, so a value with anything after the version (`1.2.3; drop table`) does not
 * parse. Build metadata (`+abc`) is accepted and ignored, as semver orders it.
 */
const VERSION_PATTERN =
	/^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;

/** The CLI's User-Agent product token: `alethia-cli/<version>`, read up to the first space. */
const USER_AGENT_PATTERN = /^alethia-cli\/(\S{1,80})(?:\s|$)/;

/**
 * Parses a version string the CLI sent or the operator configured. Returns null for anything that is
 * not a plain semantic version, including `dev` and the empty string.
 */
export function parseCliVersion(raw: string | null | undefined): CliVersion | null {
	if (!raw) return null;
	const match = VERSION_PATTERN.exec(raw.trim());
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ?? null,
	};
}

/** Renders a parsed version back as `major.minor.patch[-prerelease]`. */
export function formatCliVersion(version: CliVersion): string {
	const core = `${version.major}.${version.minor}.${version.patch}`;
	return version.prerelease ? `${core}-${version.prerelease}` : core;
}

/**
 * True when `version` orders strictly before `minimum`. A pre-release orders before its release
 * (`1.4.0-rc.1` < `1.4.0`); two pre-releases of the same release are not ordered against each other,
 * so neither refuses the other.
 */
export function isBelowMinimum(version: CliVersion, minimum: CliVersion): boolean {
	if (version.major !== minimum.major) return version.major < minimum.major;
	if (version.minor !== minimum.minor) return version.minor < minimum.minor;
	if (version.patch !== minimum.patch) return version.patch < minimum.patch;
	return version.prerelease !== null && minimum.prerelease === null;
}

/**
 * The version the request names: the `X-Alethia-CLI-Version` header, else the version in an
 * `alethia-cli/<v>` User-Agent. Null when neither names a parseable version.
 */
export function requestCliVersion(headers: Headers): CliVersion | null {
	const declared = parseCliVersion(headers.get(CLI_VERSION_HEADER));
	if (declared) return declared;
	const agent = USER_AGENT_PATTERN.exec(headers.get("user-agent") ?? "");
	return agent ? parseCliVersion(agent[1]) : null;
}

/**
 * The minimum CLI version this server accepts, from `ALETHIA_MIN_CLI_VERSION`. Null when it is unset
 * or does not parse, which turns the refusal off.
 */
export function configuredMinimumCliVersion(): CliVersion | null {
	return parseCliVersion(process.env.ALETHIA_MIN_CLI_VERSION);
}

/** The outcome of the handshake for one request. */
export type CliHandshake =
	| { ok: true; minimum: CliVersion | null }
	| { ok: false; minimum: CliVersion; version: CliVersion };

/**
 * Decides the handshake for a request's headers against a minimum. Refuses only a parseable version
 * strictly below a configured minimum; everything else passes (see the module comment).
 */
export function checkCliHandshake(
	headers: Headers,
	minimum: CliVersion | null,
): CliHandshake {
	if (!minimum) return { ok: true, minimum: null };
	const version = requestCliVersion(headers);
	if (!version || !isBelowMinimum(version, minimum)) return { ok: true, minimum };
	return { ok: false, minimum, version };
}

/**
 * The 426 answer for a CLI below the minimum. The body uses the CLI's error fields (`error`, `code`,
 * `hint`, `request_id`) so it renders as one sentence and exits 14. The versions in it are re-rendered
 * from the parsed numbers, never copied from the header text.
 */
export function cliTooOldResponse(
	refusal: Extract<CliHandshake, { ok: false }>,
	requestId: string,
): NextResponse {
	const minimum = formatCliVersion(refusal.minimum);
	return NextResponse.json(
		{
			error: `This Alethia CLI (${formatCliVersion(refusal.version)}) is older than the minimum this server accepts (${minimum}).`,
			code: CLI_TOO_OLD_CODE,
			hint: "alethia update",
			request_id: requestId,
		},
		{ status: 426, headers: { [CLI_MIN_VERSION_HEADER]: minimum } },
	);
}
