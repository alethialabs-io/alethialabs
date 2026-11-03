// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { linkedFromProviders } from "@/components/settings/preview/preview-settings-skeleton";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";

/**
 * Whether the viewer has a git account linked, read on the server before the chooser's skeleton
 * draws (#6351, the #6335 pattern). The import card is either the repository row or the "No Git
 * accounts linked" panel, and nothing else on the screen says which, so a skeleton that guessed was
 * a card's height wrong for one of the two kinds of viewer. The read goes through the request's
 * query client: the page's prefetch of the same key in the same request is answered from it, not
 * read twice. A failed read is `undefined`, which draws the row — what the selector shows while it
 * reads the list itself.
 */
export async function readLinkedGitAccounts(): Promise<boolean | undefined> {
	const queryClient = getQueryClient();
	const options = serverOrpc().projects.linkedGitProviders.queryOptions();
	await queryClient.prefetchQuery(options);
	return linkedFromProviders(queryClient.getQueryData(options.queryKey));
}
