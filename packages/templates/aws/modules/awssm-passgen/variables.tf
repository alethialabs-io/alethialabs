variable "custom_secrets" {
  description = "List of custom secrets to create"
  type = list(object({
    secret_name      = string
    length           = optional(number)
    special          = optional(bool)
    override_special = optional(string)
    keepers          = optional(map(string))
    manual           = optional(bool, false)
    value            = optional(string)
  }))
}

variable "secret_name_prefix" {
  description = "Prefix for secret names"
  type        = string
  default     = ""
}

variable "secret_name_suffix" {
  description = "Suffix for secret names"
  type        = string
  default     = ""
}

variable "secret_keepers" {
  description = "Map of keepers for the secrets"
  type        = map(map(string))
  default     = {}
}
