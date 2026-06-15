import { ProviderIcon } from "@/components/provider-icon";

export type GitProvider = "github" | "gitlab" | "bitbucket";

interface GitProviderIconProps {
	provider: GitProvider | string;
	className?: string;
	size?: number;
}

export function GitProviderIcon({ provider, className, size = 16 }: GitProviderIconProps) {
	return <ProviderIcon provider={provider} size={size} className={className} />;
}
