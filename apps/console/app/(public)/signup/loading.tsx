// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";
import { AuthCard, AuthShell } from "@/components/auth/auth-shell";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";

/**
 * /signup while the server checks for a session: the shell with its real switch link, and the
 * provider step's own shape in its card — eyebrow, heading, one line of copy, the lead provider at
 * full width, the row of three, and the SSO button — so the answered form does not move when it
 * arrives. Sign-up has a known layout, so this is a skeleton, not the mark loader. Synchronous, as
 * every `loading.tsx` must be.
 */
export default function SignUpLoading() {
	return (
		<AuthShell switchPrompt="Already have an account?" switchHref="/login" switchLabel="Sign in">
			<AuthCard>
				<SkeletonRoot>
					<div className="mb-6 flex flex-col gap-2.5">
						<Skeleton className="h-3 w-24" />
						<Skeleton className="h-9 w-56 max-w-full" />
						<Skeleton className="h-5 w-full" />
					</div>
					<div className="space-y-[9px]">
						<Skeleton className="mt-2 h-[46px] w-full rounded-none" />
						<div className="grid grid-cols-3 gap-[9px]">
							<Skeleton className="h-[46px] w-full rounded-none" />
							<Skeleton className="h-[46px] w-full rounded-none" />
							<Skeleton className="h-[46px] w-full rounded-none" />
						</div>
						<Skeleton className="h-[46px] w-full rounded-none" />
					</div>
				</SkeletonRoot>
			</AuthCard>
		</AuthShell>
	);
}
