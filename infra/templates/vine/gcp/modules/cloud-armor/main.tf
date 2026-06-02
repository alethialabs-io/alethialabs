resource "google_compute_security_policy" "policy" {
  name        = "${var.project_name}-${var.environment}-armor-policy"
  project     = var.project_id
  description = "Cloud Armor security policy for ${var.project_name} (${var.environment})"

  # Default deny rule (lowest priority = evaluated last)
  rule {
    action   = "deny(403)"
    priority = 2147483647

    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }

    description = "Default deny rule"
  }

  # Custom WAF rules (preconfigured expressions, IP allow/deny, etc.)
  dynamic "rule" {
    for_each = var.rules

    content {
      action   = rule.value.action
      priority = rule.value.priority

      match {
        expr {
          expression = rule.value.expression
        }
      }

      description = rule.value.description
    }
  }

  # Optional rate-limiting rule
  dynamic "rule" {
    for_each = var.enable_rate_limiting ? [1] : []

    content {
      action   = "throttle"
      priority = 900

      match {
        versioned_expr = "SRC_IPS_V1"
        config {
          src_ip_ranges = ["*"]
        }
      }

      rate_limit_options {
        conform_action = "allow"
        exceed_action  = "deny(429)"

        rate_limit_threshold {
          count        = var.rate_limit_threshold
          interval_sec = 60
        }
      }

      description = "Rate limiting: ${var.rate_limit_threshold} requests/min per IP"
    }
  }
}
