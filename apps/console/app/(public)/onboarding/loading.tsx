// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";
import { AuthShell } from "@/components/auth/auth-shell";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";

/**
 * /onboarding while the server decides where setup stands: the form's own shape — heading, the two
 * plan tiles, the name field and the button — at the form's width, so the answered page does not
 * move when it arrives. Synchronous, as every `loading.tsx` must be.
 */
export default function OnboardingLoading() {
	return (
		<AuthShell cardWidth="fluid">
			<SkeletonRoot className="mx-auto w-full max-w-[560px]">
				<div className="mb-8 flex flex-col gap-2.5">
					<Skeleton className="h-3 w-24" />
					<Skeleton className="h-10 w-80 max-w-full" />
					<Skeleton className="h-5 w-full" />
				</div>
				<div className="flex flex-col gap-2.5">
					<Skeleton className="h-3 w-12" />
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<Skeleton className="h-[138px] w-full rounded-lg" />
						<Skeleton className="h-[138px] w-full rounded-lg" />
					</div>
				</div>
				<div className="my-7 h-px bg-border" />
				<div className="flex flex-col gap-2.5">
					<Skeleton className="h-3 w-36" />
					<Skeleton className="h-[46px] w-full rounded-none" />
					<Skeleton className="h-4 w-48" />
				</div>
				<div className="mt-8 flex flex-col gap-3">
					<Skeleton className="h-[46px] w-full rounded-none" />
					<Skeleton className="mx-auto h-3 w-56" />
				</div>
			</SkeletonRoot>
		</AuthShell>
	);
}
