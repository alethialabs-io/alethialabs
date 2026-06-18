// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getServiceDb } from "@/lib/db";
import { jobs, providerTokens, specRepositories } from "@/lib/db/schema";
import type { GitProvider as PublicGitProvider } from "@/lib/db/schema";
import { verifyWorkerToken } from "@/lib/workers/auth";

const PROVIDER_OAUTH: Record<
	string,
	{
		tokenUrl: string;
		clientIdEnv: string;
		clientSecretEnv: string;
		buildBody: (
			clientId: string,
			clientSecret: string,
			refreshToken: string,
		) => Record<string, string>;
		useBasicAuth?: boolean;
	}
> = {
	github: {
		tokenUrl: "https://github.com/login/oauth/access_token",
		clientIdEnv: "GITHUB_CLIENT_ID",
		clientSecretEnv: "GITHUB_CLIENT_SECRET",
		buildBody: (clientId, clientSecret, refreshToken) => ({
			client_id: clientId,
			client_secret: clientSecret,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
	},
	gitlab: {
		tokenUrl: "https://gitlab.itgix.com/oauth/token",
		clientIdEnv: "GITLAB_APPLICATION_ID",
		clientSecretEnv: "GITLAB_SECRET",
		buildBody: (clientId, clientSecret, refreshToken) => ({
			client_id: clientId,
			client_secret: clientSecret,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
	},
	bitbucket: {
		tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
		clientIdEnv: "BITBUCKET_KEY",
		clientSecretEnv: "BITBUCKET_SECRET",
		buildBody: (_clientId, _clientSecret, refreshToken) => ({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
		useBasicAuth: true,
	},
};

type ServiceDb = ReturnType<typeof getServiceDb>;

/** Refreshes an expired token and persists the new one (service-role context). */
async function refreshAndPersist(
	db: ServiceDb,
	userId: string,
	provider: PublicGitProvider,
	data: {
		access_token: string;
		refresh_token: string | null;
		expires_at: Date | null;
	},
): Promise<string> {
	if (!data.expires_at || data.expires_at > new Date()) {
		return data.access_token;
	}

	if (!data.refresh_token) return data.access_token;

	const oauth = PROVIDER_OAUTH[provider];
	if (!oauth) return data.access_token;

	const clientId = process.env[oauth.clientIdEnv];
	const clientSecret = process.env[oauth.clientSecretEnv];
	if (!clientId || !clientSecret) return data.access_token;

	try {
		const body = oauth.buildBody(clientId, clientSecret, data.refresh_token);
		const headers: Record<string, string> = { Accept: "application/json" };

		let fetchBody: string;
		if (oauth.useBasicAuth) {
			headers["Authorization"] =
				"Basic " +
				Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
			headers["Content-Type"] = "application/x-www-form-urlencoded";
			fetchBody = new URLSearchParams(body).toString();
		} else {
			headers["Content-Type"] = "application/json";
			fetchBody = JSON.stringify(body);
		}

		const res = await fetch(oauth.tokenUrl, {
			method: "POST",
			headers,
			body: fetchBody,
		});

		if (!res.ok) return data.access_token;

		const result: {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		} = await res.json();
		if (!result.access_token) return data.access_token;

		const newAccessToken = result.access_token;
		const expiresAt = result.expires_in
			? new Date(Date.now() + result.expires_in * 1000)
			: null;

		await db
			.insert(providerTokens)
			.values({
				user_id: userId,
				provider,
				access_token: newAccessToken,
				refresh_token: result.refresh_token || data.refresh_token,
				expires_at: expiresAt,
				updated_at: new Date(),
			})
			.onConflictDoUpdate({
				target: [providerTokens.user_id, providerTokens.provider],
				set: {
					access_token: newAccessToken,
					refresh_token: result.refresh_token || data.refresh_token,
					expires_at: expiresAt,
					updated_at: new Date(),
				},
			});

		return newAccessToken;
	} catch {
		return data.access_token;
	}
}

/** Returns the git provider token for the user who owns a job. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { workerId, error: authError } = await verifyWorkerToken(req);
	if (authError) return authError;

	const { id: jobId } = await params;

	try {
		const db = getServiceDb();

		// Look up the job and verify the calling worker owns it
		const [job] = await db
			.select({
				user_id: jobs.user_id,
				spec_id: jobs.spec_id,
				runner_id: jobs.runner_id,
			})
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);

		if (!job) {
			return NextResponse.json({ error: "Job not found" }, { status: 404 });
		}

		if (job.runner_id !== workerId) {
			return NextResponse.json(
				{ error: "Worker does not own this job" },
				{ status: 403 },
			);
		}

		// Get the spec's repository URL to determine the git provider
		const [repos] = job.spec_id
			? await db
					.select({
						apps_destination_repo: specRepositories.apps_destination_repo,
					})
					.from(specRepositories)
					.where(eq(specRepositories.spec_id, job.spec_id))
					.limit(1)
			: [];

		const repoUrl = repos?.apps_destination_repo || "";
		const gitProvider: PublicGitProvider = repoUrl.includes("gitlab")
			? "gitlab"
			: repoUrl.includes("bitbucket")
				? "bitbucket"
				: "github";

		// Fetch the user's provider token using the service connection
		const [tokenRow] = await db
			.select({
				access_token: providerTokens.access_token,
				refresh_token: providerTokens.refresh_token,
				expires_at: providerTokens.expires_at,
			})
			.from(providerTokens)
			.where(
				and(
					eq(providerTokens.user_id, job.user_id),
					eq(providerTokens.provider, gitProvider),
				),
			)
			.limit(1);

		if (!tokenRow?.access_token) {
			return NextResponse.json({ token: null });
		}

		const token = await refreshAndPersist(
			db,
			job.user_id,
			gitProvider,
			tokenRow,
		);

		return NextResponse.json({ token });
	} catch (err: unknown) {
		console.error("Git token fetch error:", err);
		return NextResponse.json(
			{ error: "Internal Server Error" },
			{ status: 500 },
		);
	}
}
