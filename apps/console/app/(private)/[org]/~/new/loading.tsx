// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChooserSkeleton } from "@/components/create-project/create-project-skeletons";
import { readLinkedGitAccounts } from "@/components/create-project/read-linked-git-accounts";
import { isByoIacEnabled } from "@/lib/addons/byo-iac-flag";
import { isByoHelmEnabled } from "@/lib/addons/byo-flag";

/**
 * Instant skeleton for the new-project route, in the shape of the screen a bare `/~/new` lands on:
 * the source chooser (no title above it). The Configure step has its own boundary inside the page
 * (`ConfigureSkeleton`), because a `loading.tsx` cannot read the `?scan=` / `?scratch=` that decide
 * which of the two screens is coming.
 *
 * It reads the viewer's linked git accounts BEFORE it draws (#6351, as the Preview settings route
 * does since #6335): the import card is the repository row or the "No Git accounts linked" panel,
 * and the two are a card's height apart. A skeleton that always drew the row was 166px against the
 * 398px card a viewer with nothing linked gets.
 */
export default async function NewProjectLoading() {
	return (
		<ChooserSkeleton
			byoHelmEnabled={isByoHelmEnabled()}
			byoIacEnabled={isByoIacEnabled()}
			linked={await readLinkedGitAccounts()}
		/>
	);
}
