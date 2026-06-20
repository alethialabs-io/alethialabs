variable "name_prefix" {
  type        = string
  description = "Prefix for all resource names (e.g. runner-dev)."
}

variable "alethia_api_secret" {
  type        = string
  sensitive   = true
  description = "Shared platform secret (Bearer) for the console /api/platform/queue probe."
}

variable "runners" {
  type = list(object({
    region      = string
    cluster     = string
    service     = string
    alethia_url = string
  }))
  description = "ECS runner services the scaler manages, each with its runner's console URL."
}
