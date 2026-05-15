import { verifyCliToken } from "@/lib/cli/auth";
import { configurationToInstallerYaml } from "@/lib/configurations/installer-config";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ project_name: string }> },
) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) {
		return authError;
	}

	const userId = payload.sub;
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload" },
			{ status: 400 },
		);
	}

	const { searchParams } = new URL(req.url);
	const format = searchParams.get("format") || "legacy-yaml";
	if (format !== "legacy-yaml") {
		return NextResponse.json(
			{ error: "Unsupported export format" },
			{ status: 400 },
		);
	}

	const { project_name } = await params;
	const supabase = await createServiceRoleClient();
	const { data: config, error } = await supabase
		.from("configurations")
		.select("*")
		.eq("project_name", project_name)
		.eq("user_id", userId)
		.single();

	if (error || !config) {
		return NextResponse.json(
			{ error: "Configuration not found or unauthorized" },
			{ status: 404 },
		);
	}

	await supabase
		.from("configurations")
		.update({
			download_count: (config.download_count || 0) + 1,
			last_downloaded_at: new Date().toISOString(),
		})
		.eq("id", config.id)
		.eq("user_id", userId);

	const content = configurationToInstallerYaml(config);
	const filename = `${config.project_name || "output"}-config.yaml`;

	return NextResponse.json({ content, filename, format });
}
