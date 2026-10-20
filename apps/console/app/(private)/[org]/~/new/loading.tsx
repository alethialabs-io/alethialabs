// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { FormSkeleton } from "@/components/skeletons/page-skeletons";

/** Instant skeleton for the new-project route: the form, with no title above it. */
export default function NewProjectLoading() {
	return <FormSkeleton fields={5} />;
}
