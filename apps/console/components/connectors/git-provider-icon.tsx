// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ProviderIcon } from "@repo/ui/provider-icon";

export type GitProvider = "github" | "gitlab" | "bitbucket";

interface GitProviderIconProps {
	provider: GitProvider | string;
	className?: string;
	size?: number;
}

export function GitProviderIcon({ provider, className, size = 16 }: GitProviderIconProps) {
	return <ProviderIcon provider={provider} size={size} className={className} />;
}
