// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";
import { AuthShell } from "@/components/auth/auth-shell";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";

/**
 * /auth/oauth/consent while the route loads: the consent form's own shape — eyebrow, heading, the
 * requesting app's line, the bordered list of what it may do, the note, and Deny / Approve — so
 * the answered form does not move when it arrives. Synchronous, as every `loading.tsx` must be.
 */
export default function OAuthConsentLoading() {
	return (
		<AuthShell>
			<SkeletonRoot className="space-y-8">
				<div className="space-y-3">
					<Skeleton className="h-3 w-20" />
					<Skeleton className="h-9 w-72 max-w-full" />
					<Skeleton className="h-5 w-full" />
				</div>
				<div className="space-y-4">
					<div className="border border-border">
						<Skeleton className="mx-4 mt-3 mb-2 h-3 w-28" />
						<div className="divide-y divide-border">
							<div className="px-4 py-3">
								<Skeleton className="h-4 w-3/5" />
							</div>
							<div className="px-4 py-3">
								<Skeleton className="h-4 w-1/2" />
							</div>
						</div>
					</div>
					<Skeleton className="h-3 w-full" />
					<div className="flex gap-2">
						<Skeleton className="h-12 flex-1 rounded-none" />
						<Skeleton className="h-12 flex-1 rounded-none" />
					</div>
				</div>
			</SkeletonRoot>
		</AuthShell>
	);
}
