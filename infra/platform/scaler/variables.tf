variable "name_prefix" {
  type        = string
  description = "Prefix for all resource names (e.g. tendril-dev)."
}

variable "supabase_url" {
  type        = string
  description = "Supabase project URL for querying provision_jobs."
}

variable "supabase_service_role_key" {
  type        = string
  sensitive   = true
  description = "Supabase service role key (server-side, bypasses RLS)."
}

variable "workers" {
  type = list(object({
    region  = string
    cluster = string
    service = string
  }))
  description = "List of ECS worker services the scaler manages."
}
