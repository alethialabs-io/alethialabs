import { verifyWorkerToken } from "@/lib/workers/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

/** Deletes a worker record. Called by grape-worker after successful terraform destroy. */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { error: authError } = await verifyWorkerToken(req);
	if (authError) return authError;

	const { id: workerId } = await params;

	try {
		const supabase = await createServiceRoleClient();
		const { error } = await supabase
			.from("workers")
			.delete()
			.eq("id", workerId);

		if (error) {
			return NextResponse.json(
				{ error: "Failed to delete worker: " + error.message },
				{ status: 500 },
			);
		}

		return NextResponse.json({ success: true });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
