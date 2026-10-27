// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChooserSkeleton } from "@/components/create-project/create-project-skeletons";

/**
 * Instant skeleton for the new-project route, in the shape of the screen a bare `/~/new` lands on:
 * the source chooser (no title above it). The Configure step has its own boundary inside the page
 * (`ConfigureSkeleton`), because a `loading.tsx` cannot read the `?scan=` / `?scratch=` that decide
 * which of the two screens is coming.
 */
export default function NewProjectLoading() {
	return <ChooserSkeleton />;
}
