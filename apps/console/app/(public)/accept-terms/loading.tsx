// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";
import { AuthCard, AuthShell } from "@/components/auth/auth-shell";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";

/**
 * /accept-terms while the server reads which documents are outstanding: the acceptance form's own
 * shape in its card — heading, a line of copy, the checkbox row with its hint, and the full-width
 * button — so the answered form does not move when it arrives. Synchronous, as every
 * `loading.tsx` must be.
 */
export default function AcceptTermsLoading() {
	return (
		<AuthShell>
			<AuthCard>
				<SkeletonRoot className="flex flex-col gap-6">
					<div className="flex flex-col gap-2">
						<Skeleton className="h-9 w-64 max-w-full" />
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-4/5" />
					</div>
					<div className="flex flex-col gap-2">
						<div className="flex items-start gap-3">
							<Skeleton className="mt-0.5 size-4 rounded-none" />
							<Skeleton className="h-4 flex-1" />
						</div>
						<Skeleton className="ml-7 h-3 w-3/5" />
					</div>
					<Skeleton className="h-[46px] w-full rounded-none" />
				</SkeletonRoot>
			</AuthCard>
		</AuthShell>
	);
}
