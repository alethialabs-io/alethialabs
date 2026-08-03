resource "google_compute_security_policy" "policy" {
  name        = "${var.project_name}-${var.environment}-armor-policy"
  project     = var.project_id
  description = "Cloud Armor security policy for ${var.project_name} (${var.environment})"

  # The default rule (priority 2147483647 = evaluated last, matches everything the custom rules
  # below did not). Its action is var.default_action, NOT a hardcoded deny(403) — that literal was
  # the whole reason this policy was safe to leave detached (#1826). `cloud_armor_default_action`
  # has been declared at the root since the template shipped, defaulting to "allow", and no module
  # ever read it; the policy therefore denied 100% of requests whatever the operator chose. Nothing
  # noticed because the policy was attached to nothing, so the deny applied to no traffic at all.
  #
  # Now that a GKE Ingress BackendConfig actually binds this policy to the ArgoCD backend service,
  # the hardcoded deny would black-hole every request the moment the WAF switch is turned on —
  # turning "enable the WAF" into "take the platform down". The default-allow-plus-explicit-deny
  # posture the root variable always described is what a rule-list policy needs.
  rule {
    action   = var.default_action
    priority = 2147483647

    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }

    description = "Default rule (${var.default_action}) — evaluated last"
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
