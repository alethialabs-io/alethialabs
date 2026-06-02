import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { PublicGitProvider } from "@/lib/validations/db.schemas";
import { verifyWorkerToken } from "@/lib/workers/auth";
import { NextResponse } from "next/server";

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

/** Refreshes an expired token and persists the new one (service-role context). */
async function refreshAndPersist(
	supabase: Awaited<ReturnType<typeof createServiceRoleClient>>,
	userId: string,
	provider: PublicGitProvider,
	data: {
		access_token: string;
		refresh_token: string | null;
		expires_at: string | null;
	},
): Promise<string> {
	if (!data.expires_at || new Date(data.expires_at) > new Date()) {
		return data.access_token;
	}

	if (!data.refresh_token) return data.access_token;

	const oauth = PROVIDER_OAUTH[provider];
	if (!oauth) return data.access_token;

	const clientId = process.env[oauth.clientIdEnv];
	const clientSecret = process.env[oauth.clientSecretEnv];
	if (!clientId || !clientSecret) return data.access_token;

	try {
		const body = oauth.buildBody(
			clientId,
			clientSecret,
			data.refresh_token,
		);
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

		const result = await res.json();
		if (!result.access_token) return data.access_token;

		await supabase.from("provider_tokens").upsert(
			{
				user_id: userId,
				provider,
				access_token: result.access_token,
				refresh_token: result.refresh_token || data.refresh_token,
				expires_at: result.expires_in
					? new Date(
							Date.now() + result.expires_in * 1000,
						).toISOString()
					: null,
				updated_at: new Date().toISOString(),
			},
			{ onConflict: "user_id, provider" },
		);

		return result.access_token;
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
		const supabase = await createServiceRoleClient();

		// Look up the job and verify the calling worker owns it
		const { data: job, error: jobError } = await supabase
			.from("provision_jobs")
			.select("user_id, vine_id, worker_id")
			.eq("id", jobId)
			.single();

		if (jobError || !job) {
			return NextResponse.json(
				{ error: "Job not found" },
				{ status: 404 },
			);
		}

		if (job.worker_id !== workerId) {
			return NextResponse.json(
				{ error: "Worker does not own this job" },
				{ status: 403 },
			);
		}

		// Get the vine's repository URL to determine the git provider
		const { data: repos } = await supabase
			.from("vine_repositories")
			.select("apps_destination_repo")
			.eq("vine_id", job.vine_id || "")
			.maybeSingle();

		const repoUrl = repos?.apps_destination_repo || "";
		const gitProvider = repoUrl.includes("gitlab")
			? "gitlab"
			: repoUrl.includes("bitbucket")
				? "bitbucket"
				: "github";

		// Fetch the user's provider token using the service role client
		const { data: tokenRow } = await supabase
			.from("provider_tokens")
			.select("access_token, refresh_token, expires_at")
			.eq("user_id", job.user_id)
			.eq("provider", gitProvider)
			.single();

		if (!tokenRow?.access_token) {
			return NextResponse.json({ token: null });
		}

		const token = await refreshAndPersist(
			supabase,
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
