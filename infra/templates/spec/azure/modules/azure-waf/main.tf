resource "azurerm_web_application_firewall_policy" "this" {
  name                = "${var.project_name}-${var.environment}-waf"
  resource_group_name = var.resource_group_name
  location            = var.location

  managed_rules {
    managed_rule_set {
      type    = "OWASP"
      version = "3.2"
    }
  }

  dynamic "custom_rules" {
    for_each = var.rules

    content {
      name      = "rule${custom_rules.value.priority}"
      priority  = custom_rules.value.priority
      rule_type = custom_rules.value.rule_type
      action    = custom_rules.value.action

      dynamic "match_conditions" {
        for_each = custom_rules.value.match_conditions

        content {
          dynamic "match_variables" {
            for_each = lookup(match_conditions.value, "match_variables", [])

            content {
              variable_name = match_variables.value.variable_name
              selector      = lookup(match_variables.value, "selector", null)
            }
          }

          operator           = match_conditions.value.operator
          negation_condition = lookup(match_conditions.value, "negation_condition", false)
          match_values       = match_conditions.value.match_values
        }
      }
    }
  }

  tags = var.tags
}
