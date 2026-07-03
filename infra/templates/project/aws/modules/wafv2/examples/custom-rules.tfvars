# Custom WAF rules examples
# Each rule maps directly to the Terraform aws_wafv2_web_acl rule statement schema.
# Supported actions: "allow", "block", "count", "captcha", "challenge"

custom_rules = [

  # ── IP Set Blocking ──
  # Block requests from a known-bad IP set.
  # Requires an aws_wafv2_ip_set resource created separately.
  {
    name     = "block-bad-ips"
    priority = 5
    action   = "block"
    statement = {
      ip_set_reference_statement = {
        arn = "arn:aws:wafv2:us-east-1:123456789012:regional/ipset/bad-ips/abcd1234-abcd-1234-abcd-1234abcd5678"
      }
    }
  },

  # ── Byte Match on URI Path ──
  # Block access to /admin paths.
  {
    name     = "block-admin-path"
    priority = 10
    action   = "block"
    statement = {
      byte_match_statement = {
        search_string         = "/admin"
        positional_constraint = "STARTS_WITH"
        field_to_match        = { uri_path = {} }
        text_transformation   = [{ priority = 0, type = "LOWERCASE" }]
      }
    }
  },

  # ── SQL Injection Detection ──
  # Block SQLi attempts in the request body.
  {
    name     = "detect-sqli-body"
    priority = 15
    action   = "block"
    statement = {
      sqli_match_statement = {
        field_to_match      = { body = { oversize_handling = "CONTINUE" } }
        text_transformation = [{ priority = 0, type = "URL_DECODE" }, { priority = 1, type = "HTML_ENTITY_DECODE" }]
      }
    }
  },

  # ── XSS Detection ──
  # Block XSS attempts in query string.
  {
    name     = "detect-xss-query"
    priority = 20
    action   = "block"
    statement = {
      xss_match_statement = {
        field_to_match      = { query_string = {} }
        text_transformation = [{ priority = 0, type = "URL_DECODE" }, { priority = 1, type = "HTML_ENTITY_DECODE" }]
      }
    }
  },

  # ── Size Constraint ──
  # Block requests with body larger than 8KB.
  {
    name     = "limit-body-size"
    priority = 25
    action   = "block"
    statement = {
      size_constraint_statement = {
        comparison_operator = "GT"
        size                = 8192
        field_to_match      = { body = { oversize_handling = "CONTINUE" } }
        text_transformation = [{ priority = 0, type = "NONE" }]
      }
    }
  },

  # ── Regex Match ──
  # Count requests with suspicious user-agent patterns.
  {
    name     = "flag-suspicious-ua"
    priority = 30
    action   = "count"
    statement = {
      regex_match_statement = {
        regex_string        = ".*(bot|crawler|spider).*"
        field_to_match      = { single_header = { name = "user-agent" } }
        text_transformation = [{ priority = 0, type = "LOWERCASE" }]
      }
    }
  },

  # ── Label Match ──
  # Block requests labeled by a prior rule (e.g., AWS managed rule group).
  {
    name     = "block-labeled-bot"
    priority = 35
    action   = "block"
    statement = {
      label_match_statement = {
        scope = "LABEL"
        key   = "awswaf:managed:aws:bot-control:bot:unverified"
      }
    }
  },

  # ── Compound Rule: AND ──
  # Block non-US traffic to /api paths.
  {
    name     = "block-non-us-api"
    priority = 40
    action   = "block"
    statement = {
      and_statement = {
        statements = [
          {
            not_statement = {
              statement = {
                geo_match_statement = {
                  country_codes = ["US"]
                }
              }
            }
          },
          {
            byte_match_statement = {
              search_string         = "/api"
              positional_constraint = "STARTS_WITH"
              field_to_match        = { uri_path = {} }
              text_transformation   = [{ priority = 0, type = "LOWERCASE" }]
            }
          }
        ]
      }
    }
  },

  # ── Compound Rule: OR ──
  # Captcha requests to either /login or /register.
  {
    name     = "captcha-auth-endpoints"
    priority = 45
    action   = "captcha"
    statement = {
      or_statement = {
        statements = [
          {
            byte_match_statement = {
              search_string         = "/login"
              positional_constraint = "EXACTLY"
              field_to_match        = { uri_path = {} }
              text_transformation   = [{ priority = 0, type = "LOWERCASE" }]
            }
          },
          {
            byte_match_statement = {
              search_string         = "/register"
              positional_constraint = "EXACTLY"
              field_to_match        = { uri_path = {} }
              text_transformation   = [{ priority = 0, type = "LOWERCASE" }]
            }
          }
        ]
      }
    }
  },

  # ── Rate-Based Rule with Custom Scope-Down ──
  # Rate-limit POST requests to /api/login to 100 per 5 minutes.
  {
    name     = "rate-limit-login"
    priority = 50
    action   = "block"
    statement = {
      rate_based_statement = {
        limit              = 100
        aggregate_key_type = "IP"
        scope_down_statement = {
          and_statement = {
            statements = [
              {
                byte_match_statement = {
                  search_string         = "/api/login"
                  positional_constraint = "EXACTLY"
                  field_to_match        = { uri_path = {} }
                  text_transformation   = [{ priority = 0, type = "LOWERCASE" }]
                }
              },
              {
                byte_match_statement = {
                  search_string         = "POST"
                  positional_constraint = "EXACTLY"
                  field_to_match        = { method = {} }
                  text_transformation   = [{ priority = 0, type = "NONE" }]
                }
              }
            ]
          }
        }
      }
    }
  },

  # ── Regex Pattern Set Reference ──
  # Block requests matching a regex pattern set (created separately).
  # Requires an aws_wafv2_regex_pattern_set resource.
  {
    name     = "block-bad-paths"
    priority = 55
    action   = "block"
    statement = {
      regex_pattern_set_reference_statement = {
        arn                 = "arn:aws:wafv2:us-east-1:123456789012:regional/regexpatternset/bad-paths/abcd1234-abcd-1234-abcd-1234abcd5678"
        field_to_match      = { uri_path = {} }
        text_transformation = [{ priority = 0, type = "LOWERCASE" }]
      }
    }
  },

  # ── Challenge Action ──
  # Issue a silent challenge to requests with a specific header value.
  {
    name     = "challenge-suspect-header"
    priority = 60
    action   = "challenge"
    statement = {
      byte_match_statement = {
        search_string         = "suspect-client"
        positional_constraint = "EXACTLY"
        field_to_match        = { single_header = { name = "x-client-type" } }
        text_transformation   = [{ priority = 0, type = "LOWERCASE" }]
      }
    }
  },
]
