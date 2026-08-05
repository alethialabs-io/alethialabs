variable "location" {
  description = "Azure region for the key vault"
  type        = string
}

variable "vault_name" {
  description = "Name of the key vault. Derived by the caller (local.azure_key_vault_name in checks_naming.tf), which falls back to a truncated-plus-digest form once the readable \"<project_name>-<environment>-kv\" would overflow Azure's 3-24 character cap. Derived at the template root, not here, so it stays reachable from `tofu test`."
  type        = string

  validation {
    condition     = length(var.vault_name) >= 3 && length(var.vault_name) <= 24
    error_message = "vault_name must be 3-24 characters (Azure Key Vault's cap); got ${length(var.vault_name)}."
  }
}

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "tenant_id" {
  description = "Azure AD tenant ID for the key vault"
  type        = string
}

variable "secrets" {
  description = "List of secrets to create in the key vault"
  type = list(object({
    name          = string
    generate      = bool
    length        = optional(number, 32)
    special_chars = optional(bool, true)
  }))
  default = []
}

variable "secret_keepers" {
  description = "Per-secret rotation keepers, keyed by secret name. Changing any value under a name re-generates that secret's password; a name absent from the map keeps its value forever. Empty is behavior-preserving."
  type        = map(map(string))
  default     = {}
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
