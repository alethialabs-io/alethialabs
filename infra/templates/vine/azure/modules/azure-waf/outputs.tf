output "policy_id" {
  description = "The resource ID of the WAF policy"
  value       = azurerm_web_application_firewall_policy.this.id
}

output "policy_name" {
  description = "The name of the WAF policy"
  value       = azurerm_web_application_firewall_policy.this.name
}
