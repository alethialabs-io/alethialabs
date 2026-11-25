// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The repository URLs a scan accepts. A scan hands its URL to a runner, which clones it, so the URL
// is checked before the job is queued: an `https://` URL with no embedded credentials, whose host is a
// public name (not `localhost`, not a `.local`/`.localhost`/`.internal` name) and resolves only to
// public unicast addresses. The address check is the console's outbound-request guard
// (lib/net/ssrf-guard.ts), so a scan and a webhook agree on what "public" means.

import "server-only";
import { isIP } from "node:net";
import { assertSafeUrl, isPublicUnicastIp, SsrfError } from "@/lib/net/ssrf-guard";

/** A repository URL a scan does not accept, with the sentence to show. */
export class RepoUrlRefusedError extends Error {
	/** Builds the refusal from the sentence to show. */
	constructor(message: string) {
		super(message);
		this.name = "RepoUrlRefusedError";
	}
}

/** The one sentence every refusal of a host ends with: it says what to pass instead. */
const USE_PUBLIC_HTTPS = "Use the repository's public https:// URL, for example https://github.com/owner/name.";

/** Host names that never name a public repository host. */
function isLocalName(host: string): boolean {
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host === "internal" ||
		host.endsWith(".internal")
	);
}

/**
 * `raw` as the URL a scan clones, or a {@link RepoUrlRefusedError}. Resolves the host, so it is
 * async; the refusal never says what the host resolved to.
 */
export async function assertScannableRepoUrl(raw: string): Promise<string> {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new RepoUrlRefusedError(`That is not a URL. ${USE_PUBLIC_HTTPS}`);
	}
	if (url.protocol !== "https:") {
		throw new RepoUrlRefusedError(`Only https:// repository URLs can be scanned. ${USE_PUBLIC_HTTPS}`);
	}
	if (url.username !== "" || url.password !== "") {
		throw new RepoUrlRefusedError(
			"Leave credentials out of the URL. A private repository is read through its connected git account.",
		);
	}
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (isLocalName(host) || (isIP(host) !== 0 && !isPublicUnicastIp(host))) {
		throw new RepoUrlRefusedError(`That host is not a public repository host. ${USE_PUBLIC_HTTPS}`);
	}
	try {
		await assertSafeUrl(url.toString());
	} catch (err) {
		if (err instanceof SsrfError) {
			throw new RepoUrlRefusedError(`That host is not a public repository host. ${USE_PUBLIC_HTTPS}`);
		}
		throw err;
	}
	return url.toString();
}
