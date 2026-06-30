// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ProviderIcon } from "@repo/ui/provider-icon";

export type GitProvider = "github" | "gitlab" | "bitbucket";

interface GitProviderIconProps {
	provider: GitProvider | string;
	className?: string;
	size?: number;
	/** Desaturate the mark (default). Pass `false` to show real colors. */
	mono?: boolean;
}

export function GitProviderIcon({
	provider,
	className,
	size = 16,
	mono = true,
}: GitProviderIconProps) {
	return (
		<ProviderIcon provider={provider} size={size} className={className} mono={mono} />
	);
}
