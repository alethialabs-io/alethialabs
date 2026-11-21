// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AuthShell } from "@/components/auth/auth-shell";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { Skeleton } from "@repo/ui/skeleton";

/**
 * `/start` while it asks Stripe for a Checkout session — a wait of a second or two that used to be
 * a blank viewport. Drawn in the shell the page itself renders in, and in the shape of the one thing
 * the page can show instead of redirecting: the refusal's centred title, sentence and button.
 */
export default function StartLoading() {
	return (
		<AuthShell>
			<SkeletonRoot className="flex flex-col items-center gap-6 p-6 md:p-12">
				<div className="flex w-full flex-col items-center gap-2">
					<Skeleton className="h-6 w-56" />
					<Skeleton className="h-3.5 w-full" />
					<Skeleton className="h-3.5 w-4/5" />
				</div>
				<Skeleton className="h-9 w-32 rounded-none" />
			</SkeletonRoot>
		</AuthShell>
	);
}
