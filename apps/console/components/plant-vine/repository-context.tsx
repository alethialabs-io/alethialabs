"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { getLinkedProviders } from "@/app/server/actions/identities";
import { fetchRepositoriesByProvider } from "@/app/server/actions/git/repositories";
import type { Repository } from "@/app/server/actions/git/types";
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";

interface RepositoryContextValue {
	linkedProviders: PublicGitProvider[];
	reposByProvider: Record<string, Repository[]>;
	loadingProviders: boolean;
	loadingRepos: boolean;
	fetchRepos: (provider: PublicGitProvider) => Promise<void>;
}

const RepositoryContext = createContext<RepositoryContextValue | null>(null);

export function useRepositoryContext() {
	return useContext(RepositoryContext);
}

export function RepositoryProvider({ children }: { children: ReactNode }) {
	const [linkedProviders, setLinkedProviders] = useState<PublicGitProvider[]>(
		[],
	);
	const [reposByProvider, setReposByProvider] = useState<
		Record<string, Repository[]>
	>({});
	const [loadingProviders, setLoadingProviders] = useState(true);
	const [loadingRepos, setLoadingRepos] = useState(false);
	const fetchedRef = useRef(new Set<string>());

	useEffect(() => {
		getLinkedProviders().then((providers) => {
			setLinkedProviders(providers);
			setLoadingProviders(false);

			if (providers.length > 0) {
				fetchReposInternal(providers[0]);
			}
		});
	}, []);

	const fetchReposInternal = useCallback(
		async (provider: PublicGitProvider) => {
			if (fetchedRef.current.has(provider)) return;
			fetchedRef.current.add(provider);

			setLoadingRepos(true);
			try {
				const data = await fetchRepositoriesByProvider(provider);
				if (!data.error) {
					setReposByProvider((prev) => ({
						...prev,
						[provider]: data.repositories || [],
					}));
				}
			} catch {
				// Silent — individual selectors handle errors
			} finally {
				setLoadingRepos(false);
			}
		},
		[],
	);

	const fetchRepos = useCallback(
		async (provider: PublicGitProvider) => {
			await fetchReposInternal(provider);
		},
		[fetchReposInternal],
	);

	return (
		<RepositoryContext.Provider
			value={{
				linkedProviders,
				reposByProvider,
				loadingProviders,
				loadingRepos,
				fetchRepos,
			}}
		>
			{children}
		</RepositoryContext.Provider>
	);
}
