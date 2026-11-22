// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CreateProjectSkeleton } from "@/components/create-project/create-project-skeletons";
import { isByoIacEnabled } from "@/lib/addons/byo-iac-flag";
import { isByoHelmEnabled } from "@/lib/addons/byo-flag";

/**
 * Instant skeleton for the new-project route, in the screen's shape: the agent prompt, then the
 * form opened on "Standard". Synchronous: it waits on no read, because nothing in that shape depends
 * on one (the import panel, whose height did depend on the viewer's git accounts, is shown only
 * once "Import a repository" is picked).
 */
export default function NewProjectLoading() {
	return <CreateProjectSkeleton byoHelmEnabled={isByoHelmEnabled()} byoIacEnabled={isByoIacEnabled()} />;
}
