"use server";

import { createClient } from "@/lib/supabase/server";
import { PublicVineyardsInsert, PublicVineyardsUpdate } from "@/lib/validations/db.schemas";
import { Database } from "@/types/database.types";
import { QueryData, SupabaseClient } from "@supabase/supabase-js";

// Helper function to extract types
const getQueryTypes = (supabase: SupabaseClient<Database>) => {
	const getVineyardsQuery = supabase
		.from("vineyards")
		.select("*, configurations(*)");

	const createVineyardQuery = supabase
		.from("vineyards")
		.insert({} as any)
		.select()
		.single();

	return {
		getVineyardsQuery,
		createVineyardQuery,
	};
};

export type GetVineyardsData = QueryData<
	ReturnType<typeof getQueryTypes>["getVineyardsQuery"]
>;
export type CreateVineyardData = QueryData<
	ReturnType<typeof getQueryTypes>["createVineyardQuery"]
>;

export async function getVineyards() {
	try {
		const supabase = await createClient();

		const { data, error } = await supabase
			.from("vineyards")
			.select("*, configurations(*)")
			.order("created_at", { ascending: false });

		if (error) {
			console.error("Error fetching vineyards:", error);
			throw new Error(error.message);
		}

		const vineyards: GetVineyardsData = data;
		return { vineyards };
	} catch (error) {
		console.error("Unexpected error:", error);
		throw error;
	}
}

export async function getVineyardById(id: string) {
	try {
		const supabase = await createClient();

		const { data, error } = await supabase
			.from("vineyards")
			.select("*, configurations(*, harvests(*))")
			.eq("id", id)
			.single();

		if (error) {
			throw new Error(error.message);
		}

		return { vineyard: data };
	} catch (error) {
		console.error("Unexpected error:", error);
		throw error;
	}
}

export async function createVineyard(body: Omit<PublicVineyardsInsert, "user_id">) {
	try {
		const supabase = await createClient();

		const {
			data: { user },
		} = await supabase.auth.getUser();

		if (!user) {
			throw new Error("Unauthorized");
		}

		const payload = {
			...body,
			user_id: user.id,
		};

		const { data, error } = await supabase
			.from("vineyards")
			.insert(payload)
			.select()
			.single();

		if (error) {
			console.error("Error creating vineyard:", error);
			throw new Error(error.message);
		}

		const vineyard: CreateVineyardData = data;
		return { vineyard };
	} catch (error) {
		console.error("Unexpected error:", error);
		throw error;
	}
}

export async function updateVineyard(id: string, body: PublicVineyardsUpdate) {
	try {
		const supabase = await createClient();

		const { data, error } = await supabase
			.from("vineyards")
			.update(body)
			.eq("id", id)
			.select()
			.single();

		if (error) {
			throw new Error(error.message);
		}

		return { vineyard: data };
	} catch (error) {
		console.error("Unexpected error:", error);
		throw error;
	}
}

export async function deleteVineyard(id: string) {
	try {
		const supabase = await createClient();

		const { error } = await supabase
			.from("vineyards")
			.delete()
			.eq("id", id);

		if (error) {
			throw new Error(error.message);
		}

		return { success: true };
	} catch (error) {
		console.error("Unexpected error:", error);
		throw error;
	}
}