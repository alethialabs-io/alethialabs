// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getGitlabBaseUrl } from "@/lib/config/auth";
import type { GitProviderHosts } from "@/lib/git/provider-host";

/**
 * The git provider hosts this console is configured for, read from the server's environment: the
 * GitLab instance is `GITLAB_BASE_URL` (`getGitlabBaseUrl`, default `https://gitlab.com`). Server code
 * passes this to `resolveGitProvider`; a client component is handed the base URL as a prop instead,
 * because `GITLAB_BASE_URL` is not exposed to the browser.
 */
export function configuredGitProviderHosts(): GitProviderHosts {
	return { gitlabBaseUrl: getGitlabBaseUrl() };
}
