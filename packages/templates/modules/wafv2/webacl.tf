resource "aws_wafv2_web_acl" "wafv2_web_acl" {
  count       = var.waf_enabled ? 1 : 0
  name        = "${var.project}-${var.env}-${var.waf_attachment_type}-security"
  description = "Web Application Firewall"
  scope       = var.web_acl_scope

  default_action {
    dynamic "allow" {
      for_each = var.waf_default_action == "allow" ? [""] : []
      content {}
    }

    dynamic "block" {
      for_each = var.waf_default_action == "block" ? [""] : []
      content {}
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = var.web_acl_cloudwatch_enabled
    metric_name                = "WAF-Main"
    sampled_requests_enabled   = var.sampled_requests_enabled
  }

  dynamic "rule" {
    for_each = { for g in local.aws_managed_waf_rule_groups_for_acl : "${g.name}-${g.priority}" => g }

    content {
      name     = rule.value.name
      priority = rule.value.priority

      override_action {
        #count {}
        dynamic "count" {
          for_each = rule.value.action == "count" ? [""] : []
          content {}
        }

        dynamic "none" {
          for_each = rule.value.action == "none" ? [""] : []
          content {}
        }
      }

      statement {
        managed_rule_group_statement {
          name        = rule.value.name
          vendor_name = "AWS"

          # Required for AWSManagedRulesBotControlRuleSet (optional inspection_level on the group object, default COMMON).
          dynamic "managed_rule_group_configs" {
            for_each = rule.value.name == "AWSManagedRulesBotControlRuleSet" ? [try(rule.value.inspection_level, "COMMON")] : []
            content {
              aws_managed_rules_bot_control_rule_set {
                inspection_level = managed_rule_group_configs.value
              }
            }
          }

          dynamic "rule_action_override" {
            for_each = [for rule_override in try(rule.value.rules_override_to_count, []) : rule_override]

            content {
              name = rule_action_override.value
              action_to_use {
                count {}
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = var.web_acl_cloudwatch_enabled
        metric_name                = rule.value.name
        sampled_requests_enabled   = var.sampled_requests_enabled
      }
    }
  }


  # Custom managed rule groups
  dynamic "rule" {
    for_each = { for r in local.effective_custom_managed_waf_rule_groups_for_acl : r.name => r }

    content {
      name     = rule.value.name
      priority = rule.value.priority

      override_action {
        dynamic "count" {
          for_each = rule.value.action == "count" ? [""] : []
          content {}
        }

        dynamic "none" {
          for_each = rule.value.action == "none" ? [""] : []
          content {}
        }
      }

      statement {
        rule_group_reference_statement {
          arn = rule.value.rule_group_arn
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = var.web_acl_cloudwatch_enabled
        metric_name                = rule.value.name
        sampled_requests_enabled   = var.sampled_requests_enabled
      }
    }
  }

  # Custom rules with full statement support
  dynamic "rule" {
    for_each = { for r in local.custom_rules_for_acl : r.name => r }

    content {
      name     = rule.value.name
      priority = rule.value.priority

      action {
        dynamic "allow" {
          for_each = rule.value.action == "allow" ? [1] : []
          content {}
        }
        dynamic "block" {
          for_each = rule.value.action == "block" ? [1] : []
          content {}
        }
        dynamic "count" {
          for_each = rule.value.action == "count" ? [1] : []
          content {}
        }
        dynamic "captcha" {
          for_each = rule.value.action == "captcha" ? [1] : []
          content {}
        }
        dynamic "challenge" {
          for_each = rule.value.action == "challenge" ? [1] : []
          content {}
        }
      }

      statement {

        dynamic "byte_match_statement" {
          for_each = try([rule.value.statement.byte_match_statement], [])
          content {
            search_string         = byte_match_statement.value.search_string
            positional_constraint = byte_match_statement.value.positional_constraint
            dynamic "field_to_match" {
              for_each = try([byte_match_statement.value.field_to_match], [])
              content {
                dynamic "uri_path" {
                  for_each = try([field_to_match.value.uri_path], [])
                  content {}
                }
                dynamic "query_string" {
                  for_each = try([field_to_match.value.query_string], [])
                  content {}
                }
                dynamic "method" {
                  for_each = try([field_to_match.value.method], [])
                  content {}
                }
                dynamic "all_query_arguments" {
                  for_each = try([field_to_match.value.all_query_arguments], [])
                  content {}
                }
                dynamic "single_header" {
                  for_each = try([field_to_match.value.single_header], [])
                  content {
                    name = single_header.value.name
                  }
                }
                dynamic "single_query_argument" {
                  for_each = try([field_to_match.value.single_query_argument], [])
                  content {
                    name = single_query_argument.value.name
                  }
                }
                dynamic "body" {
                  for_each = try([field_to_match.value.body], [])
                  content {
                    oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                  }
                }
                dynamic "json_body" {
                  for_each = try([field_to_match.value.json_body], [])
                  content {
                    match_scope               = json_body.value.match_scope
                    invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                    oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([json_body.value.match_pattern.all], [])
                        content {}
                      }
                      included_paths = try(json_body.value.match_pattern.included_paths, null)
                    }
                  }
                }
                dynamic "cookies" {
                  for_each = try([field_to_match.value.cookies], [])
                  content {
                    match_scope       = cookies.value.match_scope
                    oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([cookies.value.match_pattern.all], [])
                        content {}
                      }
                      included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                      excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                    }
                  }
                }
                dynamic "headers" {
                  for_each = try([field_to_match.value.headers], [])
                  content {
                    match_scope       = headers.value.match_scope
                    oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([headers.value.match_pattern.all], [])
                        content {}
                      }
                      included_headers = try(headers.value.match_pattern.included_headers, null)
                      excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                    }
                  }
                }
                dynamic "ja3_fingerprint" {
                  for_each = try([field_to_match.value.ja3_fingerprint], [])
                  content {
                    fallback_behavior = ja3_fingerprint.value.fallback_behavior
                  }
                }
                dynamic "header_order" {
                  for_each = try([field_to_match.value.header_order], [])
                  content {
                    oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                  }
                }
              }
            }
            dynamic "text_transformation" {
              for_each = try(byte_match_statement.value.text_transformation, [])
              content {
                priority = text_transformation.value.priority
                type     = text_transformation.value.type
              }
            }
          }
        }

        dynamic "geo_match_statement" {
          for_each = try([rule.value.statement.geo_match_statement], [])
          content {
            country_codes = geo_match_statement.value.country_codes
            dynamic "forwarded_ip_config" {
              for_each = try([geo_match_statement.value.forwarded_ip_config], [])
              content {
                header_name       = forwarded_ip_config.value.header_name
                fallback_behavior = forwarded_ip_config.value.fallback_behavior
              }
            }
          }
        }

        dynamic "ip_set_reference_statement" {
          for_each = try([rule.value.statement.ip_set_reference_statement], [])
          content {
            arn = ip_set_reference_statement.value.arn
            dynamic "ip_set_forwarded_ip_config" {
              for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
              content {
                header_name       = ip_set_forwarded_ip_config.value.header_name
                fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                position          = ip_set_forwarded_ip_config.value.position
              }
            }
          }
        }

        dynamic "label_match_statement" {
          for_each = try([rule.value.statement.label_match_statement], [])
          content {
            scope = label_match_statement.value.scope
            key   = label_match_statement.value.key
          }
        }

        dynamic "regex_match_statement" {
          for_each = try([rule.value.statement.regex_match_statement], [])
          content {
            regex_string = regex_match_statement.value.regex_string
            dynamic "field_to_match" {
              for_each = try([regex_match_statement.value.field_to_match], [])
              content {
                dynamic "uri_path" {
                  for_each = try([field_to_match.value.uri_path], [])
                  content {}
                }
                dynamic "query_string" {
                  for_each = try([field_to_match.value.query_string], [])
                  content {}
                }
                dynamic "method" {
                  for_each = try([field_to_match.value.method], [])
                  content {}
                }
                dynamic "all_query_arguments" {
                  for_each = try([field_to_match.value.all_query_arguments], [])
                  content {}
                }
                dynamic "single_header" {
                  for_each = try([field_to_match.value.single_header], [])
                  content {
                    name = single_header.value.name
                  }
                }
                dynamic "single_query_argument" {
                  for_each = try([field_to_match.value.single_query_argument], [])
                  content {
                    name = single_query_argument.value.name
                  }
                }
                dynamic "body" {
                  for_each = try([field_to_match.value.body], [])
                  content {
                    oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                  }
                }
                dynamic "json_body" {
                  for_each = try([field_to_match.value.json_body], [])
                  content {
                    match_scope               = json_body.value.match_scope
                    invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                    oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([json_body.value.match_pattern.all], [])
                        content {}
                      }
                      included_paths = try(json_body.value.match_pattern.included_paths, null)
                    }
                  }
                }
                dynamic "cookies" {
                  for_each = try([field_to_match.value.cookies], [])
                  content {
                    match_scope       = cookies.value.match_scope
                    oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([cookies.value.match_pattern.all], [])
                        content {}
                      }
                      included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                      excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                    }
                  }
                }
                dynamic "headers" {
                  for_each = try([field_to_match.value.headers], [])
                  content {
                    match_scope       = headers.value.match_scope
                    oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([headers.value.match_pattern.all], [])
                        content {}
                      }
                      included_headers = try(headers.value.match_pattern.included_headers, null)
                      excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                    }
                  }
                }
                dynamic "ja3_fingerprint" {
                  for_each = try([field_to_match.value.ja3_fingerprint], [])
                  content {
                    fallback_behavior = ja3_fingerprint.value.fallback_behavior
                  }
                }
                dynamic "header_order" {
                  for_each = try([field_to_match.value.header_order], [])
                  content {
                    oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                  }
                }
              }
            }
            dynamic "text_transformation" {
              for_each = try(regex_match_statement.value.text_transformation, [])
              content {
                priority = text_transformation.value.priority
                type     = text_transformation.value.type
              }
            }
          }
        }

        dynamic "regex_pattern_set_reference_statement" {
          for_each = try([rule.value.statement.regex_pattern_set_reference_statement], [])
          content {
            arn = regex_pattern_set_reference_statement.value.arn
            dynamic "field_to_match" {
              for_each = try([regex_pattern_set_reference_statement.value.field_to_match], [])
              content {
                dynamic "uri_path" {
                  for_each = try([field_to_match.value.uri_path], [])
                  content {}
                }
                dynamic "query_string" {
                  for_each = try([field_to_match.value.query_string], [])
                  content {}
                }
                dynamic "method" {
                  for_each = try([field_to_match.value.method], [])
                  content {}
                }
                dynamic "all_query_arguments" {
                  for_each = try([field_to_match.value.all_query_arguments], [])
                  content {}
                }
                dynamic "single_header" {
                  for_each = try([field_to_match.value.single_header], [])
                  content {
                    name = single_header.value.name
                  }
                }
                dynamic "single_query_argument" {
                  for_each = try([field_to_match.value.single_query_argument], [])
                  content {
                    name = single_query_argument.value.name
                  }
                }
                dynamic "body" {
                  for_each = try([field_to_match.value.body], [])
                  content {
                    oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                  }
                }
                dynamic "json_body" {
                  for_each = try([field_to_match.value.json_body], [])
                  content {
                    match_scope               = json_body.value.match_scope
                    invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                    oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([json_body.value.match_pattern.all], [])
                        content {}
                      }
                      included_paths = try(json_body.value.match_pattern.included_paths, null)
                    }
                  }
                }
                dynamic "cookies" {
                  for_each = try([field_to_match.value.cookies], [])
                  content {
                    match_scope       = cookies.value.match_scope
                    oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([cookies.value.match_pattern.all], [])
                        content {}
                      }
                      included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                      excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                    }
                  }
                }
                dynamic "headers" {
                  for_each = try([field_to_match.value.headers], [])
                  content {
                    match_scope       = headers.value.match_scope
                    oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([headers.value.match_pattern.all], [])
                        content {}
                      }
                      included_headers = try(headers.value.match_pattern.included_headers, null)
                      excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                    }
                  }
                }
                dynamic "ja3_fingerprint" {
                  for_each = try([field_to_match.value.ja3_fingerprint], [])
                  content {
                    fallback_behavior = ja3_fingerprint.value.fallback_behavior
                  }
                }
                dynamic "header_order" {
                  for_each = try([field_to_match.value.header_order], [])
                  content {
                    oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                  }
                }
              }
            }
            dynamic "text_transformation" {
              for_each = try(regex_pattern_set_reference_statement.value.text_transformation, [])
              content {
                priority = text_transformation.value.priority
                type     = text_transformation.value.type
              }
            }
          }
        }

        dynamic "size_constraint_statement" {
          for_each = try([rule.value.statement.size_constraint_statement], [])
          content {
            comparison_operator = size_constraint_statement.value.comparison_operator
            size                = size_constraint_statement.value.size
            dynamic "field_to_match" {
              for_each = try([size_constraint_statement.value.field_to_match], [])
              content {
                dynamic "uri_path" {
                  for_each = try([field_to_match.value.uri_path], [])
                  content {}
                }
                dynamic "query_string" {
                  for_each = try([field_to_match.value.query_string], [])
                  content {}
                }
                dynamic "method" {
                  for_each = try([field_to_match.value.method], [])
                  content {}
                }
                dynamic "all_query_arguments" {
                  for_each = try([field_to_match.value.all_query_arguments], [])
                  content {}
                }
                dynamic "single_header" {
                  for_each = try([field_to_match.value.single_header], [])
                  content {
                    name = single_header.value.name
                  }
                }
                dynamic "single_query_argument" {
                  for_each = try([field_to_match.value.single_query_argument], [])
                  content {
                    name = single_query_argument.value.name
                  }
                }
                dynamic "body" {
                  for_each = try([field_to_match.value.body], [])
                  content {
                    oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                  }
                }
                dynamic "json_body" {
                  for_each = try([field_to_match.value.json_body], [])
                  content {
                    match_scope               = json_body.value.match_scope
                    invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                    oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([json_body.value.match_pattern.all], [])
                        content {}
                      }
                      included_paths = try(json_body.value.match_pattern.included_paths, null)
                    }
                  }
                }
                dynamic "cookies" {
                  for_each = try([field_to_match.value.cookies], [])
                  content {
                    match_scope       = cookies.value.match_scope
                    oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([cookies.value.match_pattern.all], [])
                        content {}
                      }
                      included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                      excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                    }
                  }
                }
                dynamic "headers" {
                  for_each = try([field_to_match.value.headers], [])
                  content {
                    match_scope       = headers.value.match_scope
                    oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([headers.value.match_pattern.all], [])
                        content {}
                      }
                      included_headers = try(headers.value.match_pattern.included_headers, null)
                      excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                    }
                  }
                }
                dynamic "ja3_fingerprint" {
                  for_each = try([field_to_match.value.ja3_fingerprint], [])
                  content {
                    fallback_behavior = ja3_fingerprint.value.fallback_behavior
                  }
                }
                dynamic "header_order" {
                  for_each = try([field_to_match.value.header_order], [])
                  content {
                    oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                  }
                }
              }
            }
            dynamic "text_transformation" {
              for_each = try(size_constraint_statement.value.text_transformation, [])
              content {
                priority = text_transformation.value.priority
                type     = text_transformation.value.type
              }
            }
          }
        }

        dynamic "sqli_match_statement" {
          for_each = try([rule.value.statement.sqli_match_statement], [])
          content {
            dynamic "field_to_match" {
              for_each = try([sqli_match_statement.value.field_to_match], [])
              content {
                dynamic "uri_path" {
                  for_each = try([field_to_match.value.uri_path], [])
                  content {}
                }
                dynamic "query_string" {
                  for_each = try([field_to_match.value.query_string], [])
                  content {}
                }
                dynamic "method" {
                  for_each = try([field_to_match.value.method], [])
                  content {}
                }
                dynamic "all_query_arguments" {
                  for_each = try([field_to_match.value.all_query_arguments], [])
                  content {}
                }
                dynamic "single_header" {
                  for_each = try([field_to_match.value.single_header], [])
                  content {
                    name = single_header.value.name
                  }
                }
                dynamic "single_query_argument" {
                  for_each = try([field_to_match.value.single_query_argument], [])
                  content {
                    name = single_query_argument.value.name
                  }
                }
                dynamic "body" {
                  for_each = try([field_to_match.value.body], [])
                  content {
                    oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                  }
                }
                dynamic "json_body" {
                  for_each = try([field_to_match.value.json_body], [])
                  content {
                    match_scope               = json_body.value.match_scope
                    invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                    oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([json_body.value.match_pattern.all], [])
                        content {}
                      }
                      included_paths = try(json_body.value.match_pattern.included_paths, null)
                    }
                  }
                }
                dynamic "cookies" {
                  for_each = try([field_to_match.value.cookies], [])
                  content {
                    match_scope       = cookies.value.match_scope
                    oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([cookies.value.match_pattern.all], [])
                        content {}
                      }
                      included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                      excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                    }
                  }
                }
                dynamic "headers" {
                  for_each = try([field_to_match.value.headers], [])
                  content {
                    match_scope       = headers.value.match_scope
                    oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([headers.value.match_pattern.all], [])
                        content {}
                      }
                      included_headers = try(headers.value.match_pattern.included_headers, null)
                      excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                    }
                  }
                }
                dynamic "ja3_fingerprint" {
                  for_each = try([field_to_match.value.ja3_fingerprint], [])
                  content {
                    fallback_behavior = ja3_fingerprint.value.fallback_behavior
                  }
                }
                dynamic "header_order" {
                  for_each = try([field_to_match.value.header_order], [])
                  content {
                    oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                  }
                }
              }
            }
            dynamic "text_transformation" {
              for_each = try(sqli_match_statement.value.text_transformation, [])
              content {
                priority = text_transformation.value.priority
                type     = text_transformation.value.type
              }
            }
          }
        }

        dynamic "xss_match_statement" {
          for_each = try([rule.value.statement.xss_match_statement], [])
          content {
            dynamic "field_to_match" {
              for_each = try([xss_match_statement.value.field_to_match], [])
              content {
                dynamic "uri_path" {
                  for_each = try([field_to_match.value.uri_path], [])
                  content {}
                }
                dynamic "query_string" {
                  for_each = try([field_to_match.value.query_string], [])
                  content {}
                }
                dynamic "method" {
                  for_each = try([field_to_match.value.method], [])
                  content {}
                }
                dynamic "all_query_arguments" {
                  for_each = try([field_to_match.value.all_query_arguments], [])
                  content {}
                }
                dynamic "single_header" {
                  for_each = try([field_to_match.value.single_header], [])
                  content {
                    name = single_header.value.name
                  }
                }
                dynamic "single_query_argument" {
                  for_each = try([field_to_match.value.single_query_argument], [])
                  content {
                    name = single_query_argument.value.name
                  }
                }
                dynamic "body" {
                  for_each = try([field_to_match.value.body], [])
                  content {
                    oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                  }
                }
                dynamic "json_body" {
                  for_each = try([field_to_match.value.json_body], [])
                  content {
                    match_scope               = json_body.value.match_scope
                    invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                    oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([json_body.value.match_pattern.all], [])
                        content {}
                      }
                      included_paths = try(json_body.value.match_pattern.included_paths, null)
                    }
                  }
                }
                dynamic "cookies" {
                  for_each = try([field_to_match.value.cookies], [])
                  content {
                    match_scope       = cookies.value.match_scope
                    oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([cookies.value.match_pattern.all], [])
                        content {}
                      }
                      included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                      excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                    }
                  }
                }
                dynamic "headers" {
                  for_each = try([field_to_match.value.headers], [])
                  content {
                    match_scope       = headers.value.match_scope
                    oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                    match_pattern {
                      dynamic "all" {
                        for_each = try([headers.value.match_pattern.all], [])
                        content {}
                      }
                      included_headers = try(headers.value.match_pattern.included_headers, null)
                      excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                    }
                  }
                }
                dynamic "ja3_fingerprint" {
                  for_each = try([field_to_match.value.ja3_fingerprint], [])
                  content {
                    fallback_behavior = ja3_fingerprint.value.fallback_behavior
                  }
                }
                dynamic "header_order" {
                  for_each = try([field_to_match.value.header_order], [])
                  content {
                    oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                  }
                }
              }
            }
            dynamic "text_transformation" {
              for_each = try(xss_match_statement.value.text_transformation, [])
              content {
                priority = text_transformation.value.priority
                type     = text_transformation.value.type
              }
            }
          }
        }

        dynamic "rate_based_statement" {
          for_each = try([rule.value.statement.rate_based_statement], [])
          content {
            limit                 = rate_based_statement.value.limit
            aggregate_key_type    = try(rate_based_statement.value.aggregate_key_type, "IP")
            evaluation_window_sec = try(rate_based_statement.value.evaluation_window_sec, 300)
            dynamic "forwarded_ip_config" {
              for_each = try([rate_based_statement.value.forwarded_ip_config], [])
              content {
                header_name       = forwarded_ip_config.value.header_name
                fallback_behavior = forwarded_ip_config.value.fallback_behavior
              }
            }
            dynamic "scope_down_statement" {
              for_each = try([rate_based_statement.value.scope_down_statement], [])
              content {
                dynamic "byte_match_statement" {
                  for_each = try([scope_down_statement.value.byte_match_statement], [])
                  content {
                    search_string         = byte_match_statement.value.search_string
                    positional_constraint = byte_match_statement.value.positional_constraint
                    dynamic "field_to_match" {
                      for_each = try([byte_match_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(byte_match_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "geo_match_statement" {
                  for_each = try([scope_down_statement.value.geo_match_statement], [])
                  content {
                    country_codes = geo_match_statement.value.country_codes
                    dynamic "forwarded_ip_config" {
                      for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                      content {
                        header_name       = forwarded_ip_config.value.header_name
                        fallback_behavior = forwarded_ip_config.value.fallback_behavior
                      }
                    }
                  }
                }

                dynamic "ip_set_reference_statement" {
                  for_each = try([scope_down_statement.value.ip_set_reference_statement], [])
                  content {
                    arn = ip_set_reference_statement.value.arn
                    dynamic "ip_set_forwarded_ip_config" {
                      for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                      content {
                        header_name       = ip_set_forwarded_ip_config.value.header_name
                        fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                        position          = ip_set_forwarded_ip_config.value.position
                      }
                    }
                  }
                }

                dynamic "label_match_statement" {
                  for_each = try([scope_down_statement.value.label_match_statement], [])
                  content {
                    scope = label_match_statement.value.scope
                    key   = label_match_statement.value.key
                  }
                }

                dynamic "regex_match_statement" {
                  for_each = try([scope_down_statement.value.regex_match_statement], [])
                  content {
                    regex_string = regex_match_statement.value.regex_string
                    dynamic "field_to_match" {
                      for_each = try([regex_match_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(regex_match_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "regex_pattern_set_reference_statement" {
                  for_each = try([scope_down_statement.value.regex_pattern_set_reference_statement], [])
                  content {
                    arn = regex_pattern_set_reference_statement.value.arn
                    dynamic "field_to_match" {
                      for_each = try([regex_pattern_set_reference_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(regex_pattern_set_reference_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "size_constraint_statement" {
                  for_each = try([scope_down_statement.value.size_constraint_statement], [])
                  content {
                    comparison_operator = size_constraint_statement.value.comparison_operator
                    size                = size_constraint_statement.value.size
                    dynamic "field_to_match" {
                      for_each = try([size_constraint_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(size_constraint_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "sqli_match_statement" {
                  for_each = try([scope_down_statement.value.sqli_match_statement], [])
                  content {
                    dynamic "field_to_match" {
                      for_each = try([sqli_match_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(sqli_match_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "xss_match_statement" {
                  for_each = try([scope_down_statement.value.xss_match_statement], [])
                  content {
                    dynamic "field_to_match" {
                      for_each = try([xss_match_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(xss_match_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "and_statement" {
                  for_each = try([scope_down_statement.value.and_statement], [])
                  content {
                    dynamic "statement" {
                      for_each = try(and_statement.value.statements, [])
                      content {
                        dynamic "byte_match_statement" {
                          for_each = try([statement.value.byte_match_statement], [])
                          content {
                            search_string         = byte_match_statement.value.search_string
                            positional_constraint = byte_match_statement.value.positional_constraint
                            dynamic "field_to_match" {
                              for_each = try([byte_match_statement.value.field_to_match], [])
                              content {
                                dynamic "uri_path" {
                                  for_each = try([field_to_match.value.uri_path], [])
                                  content {}
                                }
                                dynamic "query_string" {
                                  for_each = try([field_to_match.value.query_string], [])
                                  content {}
                                }
                                dynamic "method" {
                                  for_each = try([field_to_match.value.method], [])
                                  content {}
                                }
                                dynamic "all_query_arguments" {
                                  for_each = try([field_to_match.value.all_query_arguments], [])
                                  content {}
                                }
                                dynamic "single_header" {
                                  for_each = try([field_to_match.value.single_header], [])
                                  content {
                                    name = single_header.value.name
                                  }
                                }
                                dynamic "single_query_argument" {
                                  for_each = try([field_to_match.value.single_query_argument], [])
                                  content {
                                    name = single_query_argument.value.name
                                  }
                                }
                                dynamic "body" {
                                  for_each = try([field_to_match.value.body], [])
                                  content {
                                    oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                                  }
                                }
                                dynamic "json_body" {
                                  for_each = try([field_to_match.value.json_body], [])
                                  content {
                                    match_scope               = json_body.value.match_scope
                                    invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                                    oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([json_body.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_paths = try(json_body.value.match_pattern.included_paths, null)
                                    }
                                  }
                                }
                                dynamic "cookies" {
                                  for_each = try([field_to_match.value.cookies], [])
                                  content {
                                    match_scope       = cookies.value.match_scope
                                    oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([cookies.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                                      excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                                    }
                                  }
                                }
                                dynamic "headers" {
                                  for_each = try([field_to_match.value.headers], [])
                                  content {
                                    match_scope       = headers.value.match_scope
                                    oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([headers.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_headers = try(headers.value.match_pattern.included_headers, null)
                                      excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                                    }
                                  }
                                }
                                dynamic "ja3_fingerprint" {
                                  for_each = try([field_to_match.value.ja3_fingerprint], [])
                                  content {
                                    fallback_behavior = ja3_fingerprint.value.fallback_behavior
                                  }
                                }
                                dynamic "header_order" {
                                  for_each = try([field_to_match.value.header_order], [])
                                  content {
                                    oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                                  }
                                }
                              }
                            }
                            dynamic "text_transformation" {
                              for_each = try(byte_match_statement.value.text_transformation, [])
                              content {
                                priority = text_transformation.value.priority
                                type     = text_transformation.value.type
                              }
                            }
                          }
                        }

                        dynamic "geo_match_statement" {
                          for_each = try([statement.value.geo_match_statement], [])
                          content {
                            country_codes = geo_match_statement.value.country_codes
                            dynamic "forwarded_ip_config" {
                              for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                              content {
                                header_name       = forwarded_ip_config.value.header_name
                                fallback_behavior = forwarded_ip_config.value.fallback_behavior
                              }
                            }
                          }
                        }

                        dynamic "ip_set_reference_statement" {
                          for_each = try([statement.value.ip_set_reference_statement], [])
                          content {
                            arn = ip_set_reference_statement.value.arn
                            dynamic "ip_set_forwarded_ip_config" {
                              for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                              content {
                                header_name       = ip_set_forwarded_ip_config.value.header_name
                                fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                                position          = ip_set_forwarded_ip_config.value.position
                              }
                            }
                          }
                        }

                        dynamic "label_match_statement" {
                          for_each = try([statement.value.label_match_statement], [])
                          content {
                            scope = label_match_statement.value.scope
                            key   = label_match_statement.value.key
                          }
                        }
                      }
                    }
                  }
                }

                dynamic "or_statement" {
                  for_each = try([scope_down_statement.value.or_statement], [])
                  content {
                    dynamic "statement" {
                      for_each = try(or_statement.value.statements, [])
                      content {
                        dynamic "byte_match_statement" {
                          for_each = try([statement.value.byte_match_statement], [])
                          content {
                            search_string         = byte_match_statement.value.search_string
                            positional_constraint = byte_match_statement.value.positional_constraint
                            dynamic "field_to_match" {
                              for_each = try([byte_match_statement.value.field_to_match], [])
                              content {
                                dynamic "uri_path" {
                                  for_each = try([field_to_match.value.uri_path], [])
                                  content {}
                                }
                                dynamic "query_string" {
                                  for_each = try([field_to_match.value.query_string], [])
                                  content {}
                                }
                                dynamic "method" {
                                  for_each = try([field_to_match.value.method], [])
                                  content {}
                                }
                                dynamic "all_query_arguments" {
                                  for_each = try([field_to_match.value.all_query_arguments], [])
                                  content {}
                                }
                                dynamic "single_header" {
                                  for_each = try([field_to_match.value.single_header], [])
                                  content {
                                    name = single_header.value.name
                                  }
                                }
                                dynamic "single_query_argument" {
                                  for_each = try([field_to_match.value.single_query_argument], [])
                                  content {
                                    name = single_query_argument.value.name
                                  }
                                }
                                dynamic "body" {
                                  for_each = try([field_to_match.value.body], [])
                                  content {
                                    oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                                  }
                                }
                                dynamic "json_body" {
                                  for_each = try([field_to_match.value.json_body], [])
                                  content {
                                    match_scope               = json_body.value.match_scope
                                    invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                                    oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([json_body.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_paths = try(json_body.value.match_pattern.included_paths, null)
                                    }
                                  }
                                }
                                dynamic "cookies" {
                                  for_each = try([field_to_match.value.cookies], [])
                                  content {
                                    match_scope       = cookies.value.match_scope
                                    oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([cookies.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                                      excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                                    }
                                  }
                                }
                                dynamic "headers" {
                                  for_each = try([field_to_match.value.headers], [])
                                  content {
                                    match_scope       = headers.value.match_scope
                                    oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([headers.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_headers = try(headers.value.match_pattern.included_headers, null)
                                      excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                                    }
                                  }
                                }
                                dynamic "ja3_fingerprint" {
                                  for_each = try([field_to_match.value.ja3_fingerprint], [])
                                  content {
                                    fallback_behavior = ja3_fingerprint.value.fallback_behavior
                                  }
                                }
                                dynamic "header_order" {
                                  for_each = try([field_to_match.value.header_order], [])
                                  content {
                                    oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                                  }
                                }
                              }
                            }
                            dynamic "text_transformation" {
                              for_each = try(byte_match_statement.value.text_transformation, [])
                              content {
                                priority = text_transformation.value.priority
                                type     = text_transformation.value.type
                              }
                            }
                          }
                        }

                        dynamic "geo_match_statement" {
                          for_each = try([statement.value.geo_match_statement], [])
                          content {
                            country_codes = geo_match_statement.value.country_codes
                            dynamic "forwarded_ip_config" {
                              for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                              content {
                                header_name       = forwarded_ip_config.value.header_name
                                fallback_behavior = forwarded_ip_config.value.fallback_behavior
                              }
                            }
                          }
                        }

                        dynamic "ip_set_reference_statement" {
                          for_each = try([statement.value.ip_set_reference_statement], [])
                          content {
                            arn = ip_set_reference_statement.value.arn
                            dynamic "ip_set_forwarded_ip_config" {
                              for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                              content {
                                header_name       = ip_set_forwarded_ip_config.value.header_name
                                fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                                position          = ip_set_forwarded_ip_config.value.position
                              }
                            }
                          }
                        }

                        dynamic "label_match_statement" {
                          for_each = try([statement.value.label_match_statement], [])
                          content {
                            scope = label_match_statement.value.scope
                            key   = label_match_statement.value.key
                          }
                        }
                      }
                    }
                  }
                }

                dynamic "not_statement" {
                  for_each = try([scope_down_statement.value.not_statement], [])
                  content {
                    statement {
                      dynamic "byte_match_statement" {
                        for_each = try([not_statement.value.statement.byte_match_statement], [])
                        content {
                          search_string         = byte_match_statement.value.search_string
                          positional_constraint = byte_match_statement.value.positional_constraint
                          dynamic "field_to_match" {
                            for_each = try([byte_match_statement.value.field_to_match], [])
                            content {
                              dynamic "uri_path" {
                                for_each = try([field_to_match.value.uri_path], [])
                                content {}
                              }
                              dynamic "query_string" {
                                for_each = try([field_to_match.value.query_string], [])
                                content {}
                              }
                              dynamic "method" {
                                for_each = try([field_to_match.value.method], [])
                                content {}
                              }
                              dynamic "all_query_arguments" {
                                for_each = try([field_to_match.value.all_query_arguments], [])
                                content {}
                              }
                              dynamic "single_header" {
                                for_each = try([field_to_match.value.single_header], [])
                                content {
                                  name = single_header.value.name
                                }
                              }
                              dynamic "single_query_argument" {
                                for_each = try([field_to_match.value.single_query_argument], [])
                                content {
                                  name = single_query_argument.value.name
                                }
                              }
                              dynamic "body" {
                                for_each = try([field_to_match.value.body], [])
                                content {
                                  oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                                }
                              }
                              dynamic "json_body" {
                                for_each = try([field_to_match.value.json_body], [])
                                content {
                                  match_scope               = json_body.value.match_scope
                                  invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                                  oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([json_body.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_paths = try(json_body.value.match_pattern.included_paths, null)
                                  }
                                }
                              }
                              dynamic "cookies" {
                                for_each = try([field_to_match.value.cookies], [])
                                content {
                                  match_scope       = cookies.value.match_scope
                                  oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([cookies.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                                    excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                                  }
                                }
                              }
                              dynamic "headers" {
                                for_each = try([field_to_match.value.headers], [])
                                content {
                                  match_scope       = headers.value.match_scope
                                  oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([headers.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_headers = try(headers.value.match_pattern.included_headers, null)
                                    excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                                  }
                                }
                              }
                              dynamic "ja3_fingerprint" {
                                for_each = try([field_to_match.value.ja3_fingerprint], [])
                                content {
                                  fallback_behavior = ja3_fingerprint.value.fallback_behavior
                                }
                              }
                              dynamic "header_order" {
                                for_each = try([field_to_match.value.header_order], [])
                                content {
                                  oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                                }
                              }
                            }
                          }
                          dynamic "text_transformation" {
                            for_each = try(byte_match_statement.value.text_transformation, [])
                            content {
                              priority = text_transformation.value.priority
                              type     = text_transformation.value.type
                            }
                          }
                        }
                      }

                      dynamic "geo_match_statement" {
                        for_each = try([not_statement.value.statement.geo_match_statement], [])
                        content {
                          country_codes = geo_match_statement.value.country_codes
                          dynamic "forwarded_ip_config" {
                            for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                            content {
                              header_name       = forwarded_ip_config.value.header_name
                              fallback_behavior = forwarded_ip_config.value.fallback_behavior
                            }
                          }
                        }
                      }

                      dynamic "ip_set_reference_statement" {
                        for_each = try([not_statement.value.statement.ip_set_reference_statement], [])
                        content {
                          arn = ip_set_reference_statement.value.arn
                          dynamic "ip_set_forwarded_ip_config" {
                            for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                            content {
                              header_name       = ip_set_forwarded_ip_config.value.header_name
                              fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                              position          = ip_set_forwarded_ip_config.value.position
                            }
                          }
                        }
                      }

                      dynamic "label_match_statement" {
                        for_each = try([not_statement.value.statement.label_match_statement], [])
                        content {
                          scope = label_match_statement.value.scope
                          key   = label_match_statement.value.key
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }

        dynamic "and_statement" {
          for_each = try([rule.value.statement.and_statement], [])
          content {
            dynamic "statement" {
              for_each = try(and_statement.value.statements, [])
              content {
                dynamic "byte_match_statement" {
                  for_each = try([statement.value.byte_match_statement], [])
                  content {
                    search_string         = byte_match_statement.value.search_string
                    positional_constraint = byte_match_statement.value.positional_constraint
                    dynamic "field_to_match" {
                      for_each = try([byte_match_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(byte_match_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "geo_match_statement" {
                  for_each = try([statement.value.geo_match_statement], [])
                  content {
                    country_codes = geo_match_statement.value.country_codes
                    dynamic "forwarded_ip_config" {
                      for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                      content {
                        header_name       = forwarded_ip_config.value.header_name
                        fallback_behavior = forwarded_ip_config.value.fallback_behavior
                      }
                    }
                  }
                }

                dynamic "ip_set_reference_statement" {
                  for_each = try([statement.value.ip_set_reference_statement], [])
                  content {
                    arn = ip_set_reference_statement.value.arn
                    dynamic "ip_set_forwarded_ip_config" {
                      for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                      content {
                        header_name       = ip_set_forwarded_ip_config.value.header_name
                        fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                        position          = ip_set_forwarded_ip_config.value.position
                      }
                    }
                  }
                }

                dynamic "label_match_statement" {
                  for_each = try([statement.value.label_match_statement], [])
                  content {
                    scope = label_match_statement.value.scope
                    key   = label_match_statement.value.key
                  }
                }

                dynamic "regex_match_statement" {
                  for_each = try([statement.value.regex_match_statement], [])
                  content {
                    regex_string = regex_match_statement.value.regex_string
                    dynamic "field_to_match" {
                      for_each = try([regex_match_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(regex_match_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "regex_pattern_set_reference_statement" {
                  for_each = try([statement.value.regex_pattern_set_reference_statement], [])
                  content {
                    arn = regex_pattern_set_reference_statement.value.arn
                    dynamic "field_to_match" {
                      for_each = try([regex_pattern_set_reference_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(regex_pattern_set_reference_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "size_constraint_statement" {
                  for_each = try([statement.value.size_constraint_statement], [])
                  content {
                    comparison_operator = size_constraint_statement.value.comparison_operator
                    size                = size_constraint_statement.value.size
                    dynamic "field_to_match" {
                      for_each = try([size_constraint_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(size_constraint_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "sqli_match_statement" {
                  for_each = try([statement.value.sqli_match_statement], [])
                  content {
                    dynamic "field_to_match" {
                      for_each = try([sqli_match_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(sqli_match_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "xss_match_statement" {
                  for_each = try([statement.value.xss_match_statement], [])
                  content {
                    dynamic "field_to_match" {
                      for_each = try([xss_match_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(xss_match_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "and_statement" {
                  for_each = try([statement.value.and_statement], [])
                  content {
                    dynamic "statement" {
                      for_each = try(and_statement.value.statements, [])
                      content {
                        dynamic "byte_match_statement" {
                          for_each = try([statement.value.byte_match_statement], [])
                          content {
                            search_string         = byte_match_statement.value.search_string
                            positional_constraint = byte_match_statement.value.positional_constraint
                            dynamic "field_to_match" {
                              for_each = try([byte_match_statement.value.field_to_match], [])
                              content {
                                dynamic "uri_path" {
                                  for_each = try([field_to_match.value.uri_path], [])
                                  content {}
                                }
                                dynamic "query_string" {
                                  for_each = try([field_to_match.value.query_string], [])
                                  content {}
                                }
                                dynamic "method" {
                                  for_each = try([field_to_match.value.method], [])
                                  content {}
                                }
                                dynamic "all_query_arguments" {
                                  for_each = try([field_to_match.value.all_query_arguments], [])
                                  content {}
                                }
                                dynamic "single_header" {
                                  for_each = try([field_to_match.value.single_header], [])
                                  content {
                                    name = single_header.value.name
                                  }
                                }
                                dynamic "single_query_argument" {
                                  for_each = try([field_to_match.value.single_query_argument], [])
                                  content {
                                    name = single_query_argument.value.name
                                  }
                                }
                                dynamic "body" {
                                  for_each = try([field_to_match.value.body], [])
                                  content {
                                    oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                                  }
                                }
                                dynamic "json_body" {
                                  for_each = try([field_to_match.value.json_body], [])
                                  content {
                                    match_scope               = json_body.value.match_scope
                                    invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                                    oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([json_body.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_paths = try(json_body.value.match_pattern.included_paths, null)
                                    }
                                  }
                                }
                                dynamic "cookies" {
                                  for_each = try([field_to_match.value.cookies], [])
                                  content {
                                    match_scope       = cookies.value.match_scope
                                    oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([cookies.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                                      excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                                    }
                                  }
                                }
                                dynamic "headers" {
                                  for_each = try([field_to_match.value.headers], [])
                                  content {
                                    match_scope       = headers.value.match_scope
                                    oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([headers.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_headers = try(headers.value.match_pattern.included_headers, null)
                                      excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                                    }
                                  }
                                }
                                dynamic "ja3_fingerprint" {
                                  for_each = try([field_to_match.value.ja3_fingerprint], [])
                                  content {
                                    fallback_behavior = ja3_fingerprint.value.fallback_behavior
                                  }
                                }
                                dynamic "header_order" {
                                  for_each = try([field_to_match.value.header_order], [])
                                  content {
                                    oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                                  }
                                }
                              }
                            }
                            dynamic "text_transformation" {
                              for_each = try(byte_match_statement.value.text_transformation, [])
                              content {
                                priority = text_transformation.value.priority
                                type     = text_transformation.value.type
                              }
                            }
                          }
                        }

                        dynamic "geo_match_statement" {
                          for_each = try([statement.value.geo_match_statement], [])
                          content {
                            country_codes = geo_match_statement.value.country_codes
                            dynamic "forwarded_ip_config" {
                              for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                              content {
                                header_name       = forwarded_ip_config.value.header_name
                                fallback_behavior = forwarded_ip_config.value.fallback_behavior
                              }
                            }
                          }
                        }

                        dynamic "ip_set_reference_statement" {
                          for_each = try([statement.value.ip_set_reference_statement], [])
                          content {
                            arn = ip_set_reference_statement.value.arn
                            dynamic "ip_set_forwarded_ip_config" {
                              for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                              content {
                                header_name       = ip_set_forwarded_ip_config.value.header_name
                                fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                                position          = ip_set_forwarded_ip_config.value.position
                              }
                            }
                          }
                        }

                        dynamic "label_match_statement" {
                          for_each = try([statement.value.label_match_statement], [])
                          content {
                            scope = label_match_statement.value.scope
                            key   = label_match_statement.value.key
                          }
                        }
                      }
                    }
                  }
                }

                dynamic "or_statement" {
                  for_each = try([statement.value.or_statement], [])
                  content {
                    dynamic "statement" {
                      for_each = try(or_statement.value.statements, [])
                      content {
                        dynamic "byte_match_statement" {
                          for_each = try([statement.value.byte_match_statement], [])
                          content {
                            search_string         = byte_match_statement.value.search_string
                            positional_constraint = byte_match_statement.value.positional_constraint
                            dynamic "field_to_match" {
                              for_each = try([byte_match_statement.value.field_to_match], [])
                              content {
                                dynamic "uri_path" {
                                  for_each = try([field_to_match.value.uri_path], [])
                                  content {}
                                }
                                dynamic "query_string" {
                                  for_each = try([field_to_match.value.query_string], [])
                                  content {}
                                }
                                dynamic "method" {
                                  for_each = try([field_to_match.value.method], [])
                                  content {}
                                }
                                dynamic "all_query_arguments" {
                                  for_each = try([field_to_match.value.all_query_arguments], [])
                                  content {}
                                }
                                dynamic "single_header" {
                                  for_each = try([field_to_match.value.single_header], [])
                                  content {
                                    name = single_header.value.name
                                  }
                                }
                                dynamic "single_query_argument" {
                                  for_each = try([field_to_match.value.single_query_argument], [])
                                  content {
                                    name = single_query_argument.value.name
                                  }
                                }
                                dynamic "body" {
                                  for_each = try([field_to_match.value.body], [])
                                  content {
                                    oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                                  }
                                }
                                dynamic "json_body" {
                                  for_each = try([field_to_match.value.json_body], [])
                                  content {
                                    match_scope               = json_body.value.match_scope
                                    invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                                    oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([json_body.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_paths = try(json_body.value.match_pattern.included_paths, null)
                                    }
                                  }
                                }
                                dynamic "cookies" {
                                  for_each = try([field_to_match.value.cookies], [])
                                  content {
                                    match_scope       = cookies.value.match_scope
                                    oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([cookies.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                                      excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                                    }
                                  }
                                }
                                dynamic "headers" {
                                  for_each = try([field_to_match.value.headers], [])
                                  content {
                                    match_scope       = headers.value.match_scope
                                    oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([headers.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_headers = try(headers.value.match_pattern.included_headers, null)
                                      excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                                    }
                                  }
                                }
                                dynamic "ja3_fingerprint" {
                                  for_each = try([field_to_match.value.ja3_fingerprint], [])
                                  content {
                                    fallback_behavior = ja3_fingerprint.value.fallback_behavior
                                  }
                                }
                                dynamic "header_order" {
                                  for_each = try([field_to_match.value.header_order], [])
                                  content {
                                    oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                                  }
                                }
                              }
                            }
                            dynamic "text_transformation" {
                              for_each = try(byte_match_statement.value.text_transformation, [])
                              content {
                                priority = text_transformation.value.priority
                                type     = text_transformation.value.type
                              }
                            }
                          }
                        }

                        dynamic "geo_match_statement" {
                          for_each = try([statement.value.geo_match_statement], [])
                          content {
                            country_codes = geo_match_statement.value.country_codes
                            dynamic "forwarded_ip_config" {
                              for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                              content {
                                header_name       = forwarded_ip_config.value.header_name
                                fallback_behavior = forwarded_ip_config.value.fallback_behavior
                              }
                            }
                          }
                        }

                        dynamic "ip_set_reference_statement" {
                          for_each = try([statement.value.ip_set_reference_statement], [])
                          content {
                            arn = ip_set_reference_statement.value.arn
                            dynamic "ip_set_forwarded_ip_config" {
                              for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                              content {
                                header_name       = ip_set_forwarded_ip_config.value.header_name
                                fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                                position          = ip_set_forwarded_ip_config.value.position
                              }
                            }
                          }
                        }

                        dynamic "label_match_statement" {
                          for_each = try([statement.value.label_match_statement], [])
                          content {
                            scope = label_match_statement.value.scope
                            key   = label_match_statement.value.key
                          }
                        }
                      }
                    }
                  }
                }

                dynamic "not_statement" {
                  for_each = try([statement.value.not_statement], [])
                  content {
                    statement {
                      dynamic "byte_match_statement" {
                        for_each = try([not_statement.value.statement.byte_match_statement], [])
                        content {
                          search_string         = byte_match_statement.value.search_string
                          positional_constraint = byte_match_statement.value.positional_constraint
                          dynamic "field_to_match" {
                            for_each = try([byte_match_statement.value.field_to_match], [])
                            content {
                              dynamic "uri_path" {
                                for_each = try([field_to_match.value.uri_path], [])
                                content {}
                              }
                              dynamic "query_string" {
                                for_each = try([field_to_match.value.query_string], [])
                                content {}
                              }
                              dynamic "method" {
                                for_each = try([field_to_match.value.method], [])
                                content {}
                              }
                              dynamic "all_query_arguments" {
                                for_each = try([field_to_match.value.all_query_arguments], [])
                                content {}
                              }
                              dynamic "single_header" {
                                for_each = try([field_to_match.value.single_header], [])
                                content {
                                  name = single_header.value.name
                                }
                              }
                              dynamic "single_query_argument" {
                                for_each = try([field_to_match.value.single_query_argument], [])
                                content {
                                  name = single_query_argument.value.name
                                }
                              }
                              dynamic "body" {
                                for_each = try([field_to_match.value.body], [])
                                content {
                                  oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                                }
                              }
                              dynamic "json_body" {
                                for_each = try([field_to_match.value.json_body], [])
                                content {
                                  match_scope               = json_body.value.match_scope
                                  invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                                  oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([json_body.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_paths = try(json_body.value.match_pattern.included_paths, null)
                                  }
                                }
                              }
                              dynamic "cookies" {
                                for_each = try([field_to_match.value.cookies], [])
                                content {
                                  match_scope       = cookies.value.match_scope
                                  oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([cookies.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                                    excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                                  }
                                }
                              }
                              dynamic "headers" {
                                for_each = try([field_to_match.value.headers], [])
                                content {
                                  match_scope       = headers.value.match_scope
                                  oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([headers.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_headers = try(headers.value.match_pattern.included_headers, null)
                                    excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                                  }
                                }
                              }
                              dynamic "ja3_fingerprint" {
                                for_each = try([field_to_match.value.ja3_fingerprint], [])
                                content {
                                  fallback_behavior = ja3_fingerprint.value.fallback_behavior
                                }
                              }
                              dynamic "header_order" {
                                for_each = try([field_to_match.value.header_order], [])
                                content {
                                  oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                                }
                              }
                            }
                          }
                          dynamic "text_transformation" {
                            for_each = try(byte_match_statement.value.text_transformation, [])
                            content {
                              priority = text_transformation.value.priority
                              type     = text_transformation.value.type
                            }
                          }
                        }
                      }

                      dynamic "geo_match_statement" {
                        for_each = try([not_statement.value.statement.geo_match_statement], [])
                        content {
                          country_codes = geo_match_statement.value.country_codes
                          dynamic "forwarded_ip_config" {
                            for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                            content {
                              header_name       = forwarded_ip_config.value.header_name
                              fallback_behavior = forwarded_ip_config.value.fallback_behavior
                            }
                          }
                        }
                      }

                      dynamic "ip_set_reference_statement" {
                        for_each = try([not_statement.value.statement.ip_set_reference_statement], [])
                        content {
                          arn = ip_set_reference_statement.value.arn
                          dynamic "ip_set_forwarded_ip_config" {
                            for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                            content {
                              header_name       = ip_set_forwarded_ip_config.value.header_name
                              fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                              position          = ip_set_forwarded_ip_config.value.position
                            }
                          }
                        }
                      }

                      dynamic "label_match_statement" {
                        for_each = try([not_statement.value.statement.label_match_statement], [])
                        content {
                          scope = label_match_statement.value.scope
                          key   = label_match_statement.value.key
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }

        dynamic "or_statement" {
          for_each = try([rule.value.statement.or_statement], [])
          content {
            dynamic "statement" {
              for_each = try(or_statement.value.statements, [])
              content {
                dynamic "byte_match_statement" {
                  for_each = try([statement.value.byte_match_statement], [])
                  content {
                    search_string         = byte_match_statement.value.search_string
                    positional_constraint = byte_match_statement.value.positional_constraint
                    dynamic "field_to_match" {
                      for_each = try([byte_match_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(byte_match_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "geo_match_statement" {
                  for_each = try([statement.value.geo_match_statement], [])
                  content {
                    country_codes = geo_match_statement.value.country_codes
                    dynamic "forwarded_ip_config" {
                      for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                      content {
                        header_name       = forwarded_ip_config.value.header_name
                        fallback_behavior = forwarded_ip_config.value.fallback_behavior
                      }
                    }
                  }
                }

                dynamic "ip_set_reference_statement" {
                  for_each = try([statement.value.ip_set_reference_statement], [])
                  content {
                    arn = ip_set_reference_statement.value.arn
                    dynamic "ip_set_forwarded_ip_config" {
                      for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                      content {
                        header_name       = ip_set_forwarded_ip_config.value.header_name
                        fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                        position          = ip_set_forwarded_ip_config.value.position
                      }
                    }
                  }
                }

                dynamic "label_match_statement" {
                  for_each = try([statement.value.label_match_statement], [])
                  content {
                    scope = label_match_statement.value.scope
                    key   = label_match_statement.value.key
                  }
                }

                dynamic "regex_match_statement" {
                  for_each = try([statement.value.regex_match_statement], [])
                  content {
                    regex_string = regex_match_statement.value.regex_string
                    dynamic "field_to_match" {
                      for_each = try([regex_match_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(regex_match_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "regex_pattern_set_reference_statement" {
                  for_each = try([statement.value.regex_pattern_set_reference_statement], [])
                  content {
                    arn = regex_pattern_set_reference_statement.value.arn
                    dynamic "field_to_match" {
                      for_each = try([regex_pattern_set_reference_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(regex_pattern_set_reference_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "size_constraint_statement" {
                  for_each = try([statement.value.size_constraint_statement], [])
                  content {
                    comparison_operator = size_constraint_statement.value.comparison_operator
                    size                = size_constraint_statement.value.size
                    dynamic "field_to_match" {
                      for_each = try([size_constraint_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(size_constraint_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "sqli_match_statement" {
                  for_each = try([statement.value.sqli_match_statement], [])
                  content {
                    dynamic "field_to_match" {
                      for_each = try([sqli_match_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(sqli_match_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "xss_match_statement" {
                  for_each = try([statement.value.xss_match_statement], [])
                  content {
                    dynamic "field_to_match" {
                      for_each = try([xss_match_statement.value.field_to_match], [])
                      content {
                        dynamic "uri_path" {
                          for_each = try([field_to_match.value.uri_path], [])
                          content {}
                        }
                        dynamic "query_string" {
                          for_each = try([field_to_match.value.query_string], [])
                          content {}
                        }
                        dynamic "method" {
                          for_each = try([field_to_match.value.method], [])
                          content {}
                        }
                        dynamic "all_query_arguments" {
                          for_each = try([field_to_match.value.all_query_arguments], [])
                          content {}
                        }
                        dynamic "single_header" {
                          for_each = try([field_to_match.value.single_header], [])
                          content {
                            name = single_header.value.name
                          }
                        }
                        dynamic "single_query_argument" {
                          for_each = try([field_to_match.value.single_query_argument], [])
                          content {
                            name = single_query_argument.value.name
                          }
                        }
                        dynamic "body" {
                          for_each = try([field_to_match.value.body], [])
                          content {
                            oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                          }
                        }
                        dynamic "json_body" {
                          for_each = try([field_to_match.value.json_body], [])
                          content {
                            match_scope               = json_body.value.match_scope
                            invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                            oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([json_body.value.match_pattern.all], [])
                                content {}
                              }
                              included_paths = try(json_body.value.match_pattern.included_paths, null)
                            }
                          }
                        }
                        dynamic "cookies" {
                          for_each = try([field_to_match.value.cookies], [])
                          content {
                            match_scope       = cookies.value.match_scope
                            oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([cookies.value.match_pattern.all], [])
                                content {}
                              }
                              included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                              excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                            }
                          }
                        }
                        dynamic "headers" {
                          for_each = try([field_to_match.value.headers], [])
                          content {
                            match_scope       = headers.value.match_scope
                            oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                            match_pattern {
                              dynamic "all" {
                                for_each = try([headers.value.match_pattern.all], [])
                                content {}
                              }
                              included_headers = try(headers.value.match_pattern.included_headers, null)
                              excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                            }
                          }
                        }
                        dynamic "ja3_fingerprint" {
                          for_each = try([field_to_match.value.ja3_fingerprint], [])
                          content {
                            fallback_behavior = ja3_fingerprint.value.fallback_behavior
                          }
                        }
                        dynamic "header_order" {
                          for_each = try([field_to_match.value.header_order], [])
                          content {
                            oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                          }
                        }
                      }
                    }
                    dynamic "text_transformation" {
                      for_each = try(xss_match_statement.value.text_transformation, [])
                      content {
                        priority = text_transformation.value.priority
                        type     = text_transformation.value.type
                      }
                    }
                  }
                }

                dynamic "and_statement" {
                  for_each = try([statement.value.and_statement], [])
                  content {
                    dynamic "statement" {
                      for_each = try(and_statement.value.statements, [])
                      content {
                        dynamic "byte_match_statement" {
                          for_each = try([statement.value.byte_match_statement], [])
                          content {
                            search_string         = byte_match_statement.value.search_string
                            positional_constraint = byte_match_statement.value.positional_constraint
                            dynamic "field_to_match" {
                              for_each = try([byte_match_statement.value.field_to_match], [])
                              content {
                                dynamic "uri_path" {
                                  for_each = try([field_to_match.value.uri_path], [])
                                  content {}
                                }
                                dynamic "query_string" {
                                  for_each = try([field_to_match.value.query_string], [])
                                  content {}
                                }
                                dynamic "method" {
                                  for_each = try([field_to_match.value.method], [])
                                  content {}
                                }
                                dynamic "all_query_arguments" {
                                  for_each = try([field_to_match.value.all_query_arguments], [])
                                  content {}
                                }
                                dynamic "single_header" {
                                  for_each = try([field_to_match.value.single_header], [])
                                  content {
                                    name = single_header.value.name
                                  }
                                }
                                dynamic "single_query_argument" {
                                  for_each = try([field_to_match.value.single_query_argument], [])
                                  content {
                                    name = single_query_argument.value.name
                                  }
                                }
                                dynamic "body" {
                                  for_each = try([field_to_match.value.body], [])
                                  content {
                                    oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                                  }
                                }
                                dynamic "json_body" {
                                  for_each = try([field_to_match.value.json_body], [])
                                  content {
                                    match_scope               = json_body.value.match_scope
                                    invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                                    oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([json_body.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_paths = try(json_body.value.match_pattern.included_paths, null)
                                    }
                                  }
                                }
                                dynamic "cookies" {
                                  for_each = try([field_to_match.value.cookies], [])
                                  content {
                                    match_scope       = cookies.value.match_scope
                                    oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([cookies.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                                      excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                                    }
                                  }
                                }
                                dynamic "headers" {
                                  for_each = try([field_to_match.value.headers], [])
                                  content {
                                    match_scope       = headers.value.match_scope
                                    oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([headers.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_headers = try(headers.value.match_pattern.included_headers, null)
                                      excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                                    }
                                  }
                                }
                                dynamic "ja3_fingerprint" {
                                  for_each = try([field_to_match.value.ja3_fingerprint], [])
                                  content {
                                    fallback_behavior = ja3_fingerprint.value.fallback_behavior
                                  }
                                }
                                dynamic "header_order" {
                                  for_each = try([field_to_match.value.header_order], [])
                                  content {
                                    oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                                  }
                                }
                              }
                            }
                            dynamic "text_transformation" {
                              for_each = try(byte_match_statement.value.text_transformation, [])
                              content {
                                priority = text_transformation.value.priority
                                type     = text_transformation.value.type
                              }
                            }
                          }
                        }

                        dynamic "geo_match_statement" {
                          for_each = try([statement.value.geo_match_statement], [])
                          content {
                            country_codes = geo_match_statement.value.country_codes
                            dynamic "forwarded_ip_config" {
                              for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                              content {
                                header_name       = forwarded_ip_config.value.header_name
                                fallback_behavior = forwarded_ip_config.value.fallback_behavior
                              }
                            }
                          }
                        }

                        dynamic "ip_set_reference_statement" {
                          for_each = try([statement.value.ip_set_reference_statement], [])
                          content {
                            arn = ip_set_reference_statement.value.arn
                            dynamic "ip_set_forwarded_ip_config" {
                              for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                              content {
                                header_name       = ip_set_forwarded_ip_config.value.header_name
                                fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                                position          = ip_set_forwarded_ip_config.value.position
                              }
                            }
                          }
                        }

                        dynamic "label_match_statement" {
                          for_each = try([statement.value.label_match_statement], [])
                          content {
                            scope = label_match_statement.value.scope
                            key   = label_match_statement.value.key
                          }
                        }
                      }
                    }
                  }
                }

                dynamic "or_statement" {
                  for_each = try([statement.value.or_statement], [])
                  content {
                    dynamic "statement" {
                      for_each = try(or_statement.value.statements, [])
                      content {
                        dynamic "byte_match_statement" {
                          for_each = try([statement.value.byte_match_statement], [])
                          content {
                            search_string         = byte_match_statement.value.search_string
                            positional_constraint = byte_match_statement.value.positional_constraint
                            dynamic "field_to_match" {
                              for_each = try([byte_match_statement.value.field_to_match], [])
                              content {
                                dynamic "uri_path" {
                                  for_each = try([field_to_match.value.uri_path], [])
                                  content {}
                                }
                                dynamic "query_string" {
                                  for_each = try([field_to_match.value.query_string], [])
                                  content {}
                                }
                                dynamic "method" {
                                  for_each = try([field_to_match.value.method], [])
                                  content {}
                                }
                                dynamic "all_query_arguments" {
                                  for_each = try([field_to_match.value.all_query_arguments], [])
                                  content {}
                                }
                                dynamic "single_header" {
                                  for_each = try([field_to_match.value.single_header], [])
                                  content {
                                    name = single_header.value.name
                                  }
                                }
                                dynamic "single_query_argument" {
                                  for_each = try([field_to_match.value.single_query_argument], [])
                                  content {
                                    name = single_query_argument.value.name
                                  }
                                }
                                dynamic "body" {
                                  for_each = try([field_to_match.value.body], [])
                                  content {
                                    oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                                  }
                                }
                                dynamic "json_body" {
                                  for_each = try([field_to_match.value.json_body], [])
                                  content {
                                    match_scope               = json_body.value.match_scope
                                    invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                                    oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([json_body.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_paths = try(json_body.value.match_pattern.included_paths, null)
                                    }
                                  }
                                }
                                dynamic "cookies" {
                                  for_each = try([field_to_match.value.cookies], [])
                                  content {
                                    match_scope       = cookies.value.match_scope
                                    oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([cookies.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                                      excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                                    }
                                  }
                                }
                                dynamic "headers" {
                                  for_each = try([field_to_match.value.headers], [])
                                  content {
                                    match_scope       = headers.value.match_scope
                                    oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                                    match_pattern {
                                      dynamic "all" {
                                        for_each = try([headers.value.match_pattern.all], [])
                                        content {}
                                      }
                                      included_headers = try(headers.value.match_pattern.included_headers, null)
                                      excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                                    }
                                  }
                                }
                                dynamic "ja3_fingerprint" {
                                  for_each = try([field_to_match.value.ja3_fingerprint], [])
                                  content {
                                    fallback_behavior = ja3_fingerprint.value.fallback_behavior
                                  }
                                }
                                dynamic "header_order" {
                                  for_each = try([field_to_match.value.header_order], [])
                                  content {
                                    oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                                  }
                                }
                              }
                            }
                            dynamic "text_transformation" {
                              for_each = try(byte_match_statement.value.text_transformation, [])
                              content {
                                priority = text_transformation.value.priority
                                type     = text_transformation.value.type
                              }
                            }
                          }
                        }

                        dynamic "geo_match_statement" {
                          for_each = try([statement.value.geo_match_statement], [])
                          content {
                            country_codes = geo_match_statement.value.country_codes
                            dynamic "forwarded_ip_config" {
                              for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                              content {
                                header_name       = forwarded_ip_config.value.header_name
                                fallback_behavior = forwarded_ip_config.value.fallback_behavior
                              }
                            }
                          }
                        }

                        dynamic "ip_set_reference_statement" {
                          for_each = try([statement.value.ip_set_reference_statement], [])
                          content {
                            arn = ip_set_reference_statement.value.arn
                            dynamic "ip_set_forwarded_ip_config" {
                              for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                              content {
                                header_name       = ip_set_forwarded_ip_config.value.header_name
                                fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                                position          = ip_set_forwarded_ip_config.value.position
                              }
                            }
                          }
                        }

                        dynamic "label_match_statement" {
                          for_each = try([statement.value.label_match_statement], [])
                          content {
                            scope = label_match_statement.value.scope
                            key   = label_match_statement.value.key
                          }
                        }
                      }
                    }
                  }
                }

                dynamic "not_statement" {
                  for_each = try([statement.value.not_statement], [])
                  content {
                    statement {
                      dynamic "byte_match_statement" {
                        for_each = try([not_statement.value.statement.byte_match_statement], [])
                        content {
                          search_string         = byte_match_statement.value.search_string
                          positional_constraint = byte_match_statement.value.positional_constraint
                          dynamic "field_to_match" {
                            for_each = try([byte_match_statement.value.field_to_match], [])
                            content {
                              dynamic "uri_path" {
                                for_each = try([field_to_match.value.uri_path], [])
                                content {}
                              }
                              dynamic "query_string" {
                                for_each = try([field_to_match.value.query_string], [])
                                content {}
                              }
                              dynamic "method" {
                                for_each = try([field_to_match.value.method], [])
                                content {}
                              }
                              dynamic "all_query_arguments" {
                                for_each = try([field_to_match.value.all_query_arguments], [])
                                content {}
                              }
                              dynamic "single_header" {
                                for_each = try([field_to_match.value.single_header], [])
                                content {
                                  name = single_header.value.name
                                }
                              }
                              dynamic "single_query_argument" {
                                for_each = try([field_to_match.value.single_query_argument], [])
                                content {
                                  name = single_query_argument.value.name
                                }
                              }
                              dynamic "body" {
                                for_each = try([field_to_match.value.body], [])
                                content {
                                  oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                                }
                              }
                              dynamic "json_body" {
                                for_each = try([field_to_match.value.json_body], [])
                                content {
                                  match_scope               = json_body.value.match_scope
                                  invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                                  oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([json_body.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_paths = try(json_body.value.match_pattern.included_paths, null)
                                  }
                                }
                              }
                              dynamic "cookies" {
                                for_each = try([field_to_match.value.cookies], [])
                                content {
                                  match_scope       = cookies.value.match_scope
                                  oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([cookies.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                                    excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                                  }
                                }
                              }
                              dynamic "headers" {
                                for_each = try([field_to_match.value.headers], [])
                                content {
                                  match_scope       = headers.value.match_scope
                                  oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([headers.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_headers = try(headers.value.match_pattern.included_headers, null)
                                    excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                                  }
                                }
                              }
                              dynamic "ja3_fingerprint" {
                                for_each = try([field_to_match.value.ja3_fingerprint], [])
                                content {
                                  fallback_behavior = ja3_fingerprint.value.fallback_behavior
                                }
                              }
                              dynamic "header_order" {
                                for_each = try([field_to_match.value.header_order], [])
                                content {
                                  oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                                }
                              }
                            }
                          }
                          dynamic "text_transformation" {
                            for_each = try(byte_match_statement.value.text_transformation, [])
                            content {
                              priority = text_transformation.value.priority
                              type     = text_transformation.value.type
                            }
                          }
                        }
                      }

                      dynamic "geo_match_statement" {
                        for_each = try([not_statement.value.statement.geo_match_statement], [])
                        content {
                          country_codes = geo_match_statement.value.country_codes
                          dynamic "forwarded_ip_config" {
                            for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                            content {
                              header_name       = forwarded_ip_config.value.header_name
                              fallback_behavior = forwarded_ip_config.value.fallback_behavior
                            }
                          }
                        }
                      }

                      dynamic "ip_set_reference_statement" {
                        for_each = try([not_statement.value.statement.ip_set_reference_statement], [])
                        content {
                          arn = ip_set_reference_statement.value.arn
                          dynamic "ip_set_forwarded_ip_config" {
                            for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                            content {
                              header_name       = ip_set_forwarded_ip_config.value.header_name
                              fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                              position          = ip_set_forwarded_ip_config.value.position
                            }
                          }
                        }
                      }

                      dynamic "label_match_statement" {
                        for_each = try([not_statement.value.statement.label_match_statement], [])
                        content {
                          scope = label_match_statement.value.scope
                          key   = label_match_statement.value.key
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }

        dynamic "not_statement" {
          for_each = try([rule.value.statement.not_statement], [])
          content {
            statement {
              dynamic "byte_match_statement" {
                for_each = try([not_statement.value.statement.byte_match_statement], [])
                content {
                  search_string         = byte_match_statement.value.search_string
                  positional_constraint = byte_match_statement.value.positional_constraint
                  dynamic "field_to_match" {
                    for_each = try([byte_match_statement.value.field_to_match], [])
                    content {
                      dynamic "uri_path" {
                        for_each = try([field_to_match.value.uri_path], [])
                        content {}
                      }
                      dynamic "query_string" {
                        for_each = try([field_to_match.value.query_string], [])
                        content {}
                      }
                      dynamic "method" {
                        for_each = try([field_to_match.value.method], [])
                        content {}
                      }
                      dynamic "all_query_arguments" {
                        for_each = try([field_to_match.value.all_query_arguments], [])
                        content {}
                      }
                      dynamic "single_header" {
                        for_each = try([field_to_match.value.single_header], [])
                        content {
                          name = single_header.value.name
                        }
                      }
                      dynamic "single_query_argument" {
                        for_each = try([field_to_match.value.single_query_argument], [])
                        content {
                          name = single_query_argument.value.name
                        }
                      }
                      dynamic "body" {
                        for_each = try([field_to_match.value.body], [])
                        content {
                          oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                        }
                      }
                      dynamic "json_body" {
                        for_each = try([field_to_match.value.json_body], [])
                        content {
                          match_scope               = json_body.value.match_scope
                          invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                          oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([json_body.value.match_pattern.all], [])
                              content {}
                            }
                            included_paths = try(json_body.value.match_pattern.included_paths, null)
                          }
                        }
                      }
                      dynamic "cookies" {
                        for_each = try([field_to_match.value.cookies], [])
                        content {
                          match_scope       = cookies.value.match_scope
                          oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([cookies.value.match_pattern.all], [])
                              content {}
                            }
                            included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                            excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                          }
                        }
                      }
                      dynamic "headers" {
                        for_each = try([field_to_match.value.headers], [])
                        content {
                          match_scope       = headers.value.match_scope
                          oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([headers.value.match_pattern.all], [])
                              content {}
                            }
                            included_headers = try(headers.value.match_pattern.included_headers, null)
                            excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                          }
                        }
                      }
                      dynamic "ja3_fingerprint" {
                        for_each = try([field_to_match.value.ja3_fingerprint], [])
                        content {
                          fallback_behavior = ja3_fingerprint.value.fallback_behavior
                        }
                      }
                      dynamic "header_order" {
                        for_each = try([field_to_match.value.header_order], [])
                        content {
                          oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                        }
                      }
                    }
                  }
                  dynamic "text_transformation" {
                    for_each = try(byte_match_statement.value.text_transformation, [])
                    content {
                      priority = text_transformation.value.priority
                      type     = text_transformation.value.type
                    }
                  }
                }
              }

              dynamic "geo_match_statement" {
                for_each = try([not_statement.value.statement.geo_match_statement], [])
                content {
                  country_codes = geo_match_statement.value.country_codes
                  dynamic "forwarded_ip_config" {
                    for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                    content {
                      header_name       = forwarded_ip_config.value.header_name
                      fallback_behavior = forwarded_ip_config.value.fallback_behavior
                    }
                  }
                }
              }

              dynamic "ip_set_reference_statement" {
                for_each = try([not_statement.value.statement.ip_set_reference_statement], [])
                content {
                  arn = ip_set_reference_statement.value.arn
                  dynamic "ip_set_forwarded_ip_config" {
                    for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                    content {
                      header_name       = ip_set_forwarded_ip_config.value.header_name
                      fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                      position          = ip_set_forwarded_ip_config.value.position
                    }
                  }
                }
              }

              dynamic "label_match_statement" {
                for_each = try([not_statement.value.statement.label_match_statement], [])
                content {
                  scope = label_match_statement.value.scope
                  key   = label_match_statement.value.key
                }
              }

              dynamic "regex_match_statement" {
                for_each = try([not_statement.value.statement.regex_match_statement], [])
                content {
                  regex_string = regex_match_statement.value.regex_string
                  dynamic "field_to_match" {
                    for_each = try([regex_match_statement.value.field_to_match], [])
                    content {
                      dynamic "uri_path" {
                        for_each = try([field_to_match.value.uri_path], [])
                        content {}
                      }
                      dynamic "query_string" {
                        for_each = try([field_to_match.value.query_string], [])
                        content {}
                      }
                      dynamic "method" {
                        for_each = try([field_to_match.value.method], [])
                        content {}
                      }
                      dynamic "all_query_arguments" {
                        for_each = try([field_to_match.value.all_query_arguments], [])
                        content {}
                      }
                      dynamic "single_header" {
                        for_each = try([field_to_match.value.single_header], [])
                        content {
                          name = single_header.value.name
                        }
                      }
                      dynamic "single_query_argument" {
                        for_each = try([field_to_match.value.single_query_argument], [])
                        content {
                          name = single_query_argument.value.name
                        }
                      }
                      dynamic "body" {
                        for_each = try([field_to_match.value.body], [])
                        content {
                          oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                        }
                      }
                      dynamic "json_body" {
                        for_each = try([field_to_match.value.json_body], [])
                        content {
                          match_scope               = json_body.value.match_scope
                          invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                          oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([json_body.value.match_pattern.all], [])
                              content {}
                            }
                            included_paths = try(json_body.value.match_pattern.included_paths, null)
                          }
                        }
                      }
                      dynamic "cookies" {
                        for_each = try([field_to_match.value.cookies], [])
                        content {
                          match_scope       = cookies.value.match_scope
                          oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([cookies.value.match_pattern.all], [])
                              content {}
                            }
                            included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                            excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                          }
                        }
                      }
                      dynamic "headers" {
                        for_each = try([field_to_match.value.headers], [])
                        content {
                          match_scope       = headers.value.match_scope
                          oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([headers.value.match_pattern.all], [])
                              content {}
                            }
                            included_headers = try(headers.value.match_pattern.included_headers, null)
                            excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                          }
                        }
                      }
                      dynamic "ja3_fingerprint" {
                        for_each = try([field_to_match.value.ja3_fingerprint], [])
                        content {
                          fallback_behavior = ja3_fingerprint.value.fallback_behavior
                        }
                      }
                      dynamic "header_order" {
                        for_each = try([field_to_match.value.header_order], [])
                        content {
                          oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                        }
                      }
                    }
                  }
                  dynamic "text_transformation" {
                    for_each = try(regex_match_statement.value.text_transformation, [])
                    content {
                      priority = text_transformation.value.priority
                      type     = text_transformation.value.type
                    }
                  }
                }
              }

              dynamic "regex_pattern_set_reference_statement" {
                for_each = try([not_statement.value.statement.regex_pattern_set_reference_statement], [])
                content {
                  arn = regex_pattern_set_reference_statement.value.arn
                  dynamic "field_to_match" {
                    for_each = try([regex_pattern_set_reference_statement.value.field_to_match], [])
                    content {
                      dynamic "uri_path" {
                        for_each = try([field_to_match.value.uri_path], [])
                        content {}
                      }
                      dynamic "query_string" {
                        for_each = try([field_to_match.value.query_string], [])
                        content {}
                      }
                      dynamic "method" {
                        for_each = try([field_to_match.value.method], [])
                        content {}
                      }
                      dynamic "all_query_arguments" {
                        for_each = try([field_to_match.value.all_query_arguments], [])
                        content {}
                      }
                      dynamic "single_header" {
                        for_each = try([field_to_match.value.single_header], [])
                        content {
                          name = single_header.value.name
                        }
                      }
                      dynamic "single_query_argument" {
                        for_each = try([field_to_match.value.single_query_argument], [])
                        content {
                          name = single_query_argument.value.name
                        }
                      }
                      dynamic "body" {
                        for_each = try([field_to_match.value.body], [])
                        content {
                          oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                        }
                      }
                      dynamic "json_body" {
                        for_each = try([field_to_match.value.json_body], [])
                        content {
                          match_scope               = json_body.value.match_scope
                          invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                          oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([json_body.value.match_pattern.all], [])
                              content {}
                            }
                            included_paths = try(json_body.value.match_pattern.included_paths, null)
                          }
                        }
                      }
                      dynamic "cookies" {
                        for_each = try([field_to_match.value.cookies], [])
                        content {
                          match_scope       = cookies.value.match_scope
                          oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([cookies.value.match_pattern.all], [])
                              content {}
                            }
                            included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                            excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                          }
                        }
                      }
                      dynamic "headers" {
                        for_each = try([field_to_match.value.headers], [])
                        content {
                          match_scope       = headers.value.match_scope
                          oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([headers.value.match_pattern.all], [])
                              content {}
                            }
                            included_headers = try(headers.value.match_pattern.included_headers, null)
                            excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                          }
                        }
                      }
                      dynamic "ja3_fingerprint" {
                        for_each = try([field_to_match.value.ja3_fingerprint], [])
                        content {
                          fallback_behavior = ja3_fingerprint.value.fallback_behavior
                        }
                      }
                      dynamic "header_order" {
                        for_each = try([field_to_match.value.header_order], [])
                        content {
                          oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                        }
                      }
                    }
                  }
                  dynamic "text_transformation" {
                    for_each = try(regex_pattern_set_reference_statement.value.text_transformation, [])
                    content {
                      priority = text_transformation.value.priority
                      type     = text_transformation.value.type
                    }
                  }
                }
              }

              dynamic "size_constraint_statement" {
                for_each = try([not_statement.value.statement.size_constraint_statement], [])
                content {
                  comparison_operator = size_constraint_statement.value.comparison_operator
                  size                = size_constraint_statement.value.size
                  dynamic "field_to_match" {
                    for_each = try([size_constraint_statement.value.field_to_match], [])
                    content {
                      dynamic "uri_path" {
                        for_each = try([field_to_match.value.uri_path], [])
                        content {}
                      }
                      dynamic "query_string" {
                        for_each = try([field_to_match.value.query_string], [])
                        content {}
                      }
                      dynamic "method" {
                        for_each = try([field_to_match.value.method], [])
                        content {}
                      }
                      dynamic "all_query_arguments" {
                        for_each = try([field_to_match.value.all_query_arguments], [])
                        content {}
                      }
                      dynamic "single_header" {
                        for_each = try([field_to_match.value.single_header], [])
                        content {
                          name = single_header.value.name
                        }
                      }
                      dynamic "single_query_argument" {
                        for_each = try([field_to_match.value.single_query_argument], [])
                        content {
                          name = single_query_argument.value.name
                        }
                      }
                      dynamic "body" {
                        for_each = try([field_to_match.value.body], [])
                        content {
                          oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                        }
                      }
                      dynamic "json_body" {
                        for_each = try([field_to_match.value.json_body], [])
                        content {
                          match_scope               = json_body.value.match_scope
                          invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                          oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([json_body.value.match_pattern.all], [])
                              content {}
                            }
                            included_paths = try(json_body.value.match_pattern.included_paths, null)
                          }
                        }
                      }
                      dynamic "cookies" {
                        for_each = try([field_to_match.value.cookies], [])
                        content {
                          match_scope       = cookies.value.match_scope
                          oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([cookies.value.match_pattern.all], [])
                              content {}
                            }
                            included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                            excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                          }
                        }
                      }
                      dynamic "headers" {
                        for_each = try([field_to_match.value.headers], [])
                        content {
                          match_scope       = headers.value.match_scope
                          oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([headers.value.match_pattern.all], [])
                              content {}
                            }
                            included_headers = try(headers.value.match_pattern.included_headers, null)
                            excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                          }
                        }
                      }
                      dynamic "ja3_fingerprint" {
                        for_each = try([field_to_match.value.ja3_fingerprint], [])
                        content {
                          fallback_behavior = ja3_fingerprint.value.fallback_behavior
                        }
                      }
                      dynamic "header_order" {
                        for_each = try([field_to_match.value.header_order], [])
                        content {
                          oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                        }
                      }
                    }
                  }
                  dynamic "text_transformation" {
                    for_each = try(size_constraint_statement.value.text_transformation, [])
                    content {
                      priority = text_transformation.value.priority
                      type     = text_transformation.value.type
                    }
                  }
                }
              }

              dynamic "sqli_match_statement" {
                for_each = try([not_statement.value.statement.sqli_match_statement], [])
                content {
                  dynamic "field_to_match" {
                    for_each = try([sqli_match_statement.value.field_to_match], [])
                    content {
                      dynamic "uri_path" {
                        for_each = try([field_to_match.value.uri_path], [])
                        content {}
                      }
                      dynamic "query_string" {
                        for_each = try([field_to_match.value.query_string], [])
                        content {}
                      }
                      dynamic "method" {
                        for_each = try([field_to_match.value.method], [])
                        content {}
                      }
                      dynamic "all_query_arguments" {
                        for_each = try([field_to_match.value.all_query_arguments], [])
                        content {}
                      }
                      dynamic "single_header" {
                        for_each = try([field_to_match.value.single_header], [])
                        content {
                          name = single_header.value.name
                        }
                      }
                      dynamic "single_query_argument" {
                        for_each = try([field_to_match.value.single_query_argument], [])
                        content {
                          name = single_query_argument.value.name
                        }
                      }
                      dynamic "body" {
                        for_each = try([field_to_match.value.body], [])
                        content {
                          oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                        }
                      }
                      dynamic "json_body" {
                        for_each = try([field_to_match.value.json_body], [])
                        content {
                          match_scope               = json_body.value.match_scope
                          invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                          oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([json_body.value.match_pattern.all], [])
                              content {}
                            }
                            included_paths = try(json_body.value.match_pattern.included_paths, null)
                          }
                        }
                      }
                      dynamic "cookies" {
                        for_each = try([field_to_match.value.cookies], [])
                        content {
                          match_scope       = cookies.value.match_scope
                          oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([cookies.value.match_pattern.all], [])
                              content {}
                            }
                            included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                            excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                          }
                        }
                      }
                      dynamic "headers" {
                        for_each = try([field_to_match.value.headers], [])
                        content {
                          match_scope       = headers.value.match_scope
                          oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([headers.value.match_pattern.all], [])
                              content {}
                            }
                            included_headers = try(headers.value.match_pattern.included_headers, null)
                            excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                          }
                        }
                      }
                      dynamic "ja3_fingerprint" {
                        for_each = try([field_to_match.value.ja3_fingerprint], [])
                        content {
                          fallback_behavior = ja3_fingerprint.value.fallback_behavior
                        }
                      }
                      dynamic "header_order" {
                        for_each = try([field_to_match.value.header_order], [])
                        content {
                          oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                        }
                      }
                    }
                  }
                  dynamic "text_transformation" {
                    for_each = try(sqli_match_statement.value.text_transformation, [])
                    content {
                      priority = text_transformation.value.priority
                      type     = text_transformation.value.type
                    }
                  }
                }
              }

              dynamic "xss_match_statement" {
                for_each = try([not_statement.value.statement.xss_match_statement], [])
                content {
                  dynamic "field_to_match" {
                    for_each = try([xss_match_statement.value.field_to_match], [])
                    content {
                      dynamic "uri_path" {
                        for_each = try([field_to_match.value.uri_path], [])
                        content {}
                      }
                      dynamic "query_string" {
                        for_each = try([field_to_match.value.query_string], [])
                        content {}
                      }
                      dynamic "method" {
                        for_each = try([field_to_match.value.method], [])
                        content {}
                      }
                      dynamic "all_query_arguments" {
                        for_each = try([field_to_match.value.all_query_arguments], [])
                        content {}
                      }
                      dynamic "single_header" {
                        for_each = try([field_to_match.value.single_header], [])
                        content {
                          name = single_header.value.name
                        }
                      }
                      dynamic "single_query_argument" {
                        for_each = try([field_to_match.value.single_query_argument], [])
                        content {
                          name = single_query_argument.value.name
                        }
                      }
                      dynamic "body" {
                        for_each = try([field_to_match.value.body], [])
                        content {
                          oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                        }
                      }
                      dynamic "json_body" {
                        for_each = try([field_to_match.value.json_body], [])
                        content {
                          match_scope               = json_body.value.match_scope
                          invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                          oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([json_body.value.match_pattern.all], [])
                              content {}
                            }
                            included_paths = try(json_body.value.match_pattern.included_paths, null)
                          }
                        }
                      }
                      dynamic "cookies" {
                        for_each = try([field_to_match.value.cookies], [])
                        content {
                          match_scope       = cookies.value.match_scope
                          oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([cookies.value.match_pattern.all], [])
                              content {}
                            }
                            included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                            excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                          }
                        }
                      }
                      dynamic "headers" {
                        for_each = try([field_to_match.value.headers], [])
                        content {
                          match_scope       = headers.value.match_scope
                          oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                          match_pattern {
                            dynamic "all" {
                              for_each = try([headers.value.match_pattern.all], [])
                              content {}
                            }
                            included_headers = try(headers.value.match_pattern.included_headers, null)
                            excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                          }
                        }
                      }
                      dynamic "ja3_fingerprint" {
                        for_each = try([field_to_match.value.ja3_fingerprint], [])
                        content {
                          fallback_behavior = ja3_fingerprint.value.fallback_behavior
                        }
                      }
                      dynamic "header_order" {
                        for_each = try([field_to_match.value.header_order], [])
                        content {
                          oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                        }
                      }
                    }
                  }
                  dynamic "text_transformation" {
                    for_each = try(xss_match_statement.value.text_transformation, [])
                    content {
                      priority = text_transformation.value.priority
                      type     = text_transformation.value.type
                    }
                  }
                }
              }

              dynamic "and_statement" {
                for_each = try([not_statement.value.statement.and_statement], [])
                content {
                  dynamic "statement" {
                    for_each = try(and_statement.value.statements, [])
                    content {
                      dynamic "byte_match_statement" {
                        for_each = try([statement.value.byte_match_statement], [])
                        content {
                          search_string         = byte_match_statement.value.search_string
                          positional_constraint = byte_match_statement.value.positional_constraint
                          dynamic "field_to_match" {
                            for_each = try([byte_match_statement.value.field_to_match], [])
                            content {
                              dynamic "uri_path" {
                                for_each = try([field_to_match.value.uri_path], [])
                                content {}
                              }
                              dynamic "query_string" {
                                for_each = try([field_to_match.value.query_string], [])
                                content {}
                              }
                              dynamic "method" {
                                for_each = try([field_to_match.value.method], [])
                                content {}
                              }
                              dynamic "all_query_arguments" {
                                for_each = try([field_to_match.value.all_query_arguments], [])
                                content {}
                              }
                              dynamic "single_header" {
                                for_each = try([field_to_match.value.single_header], [])
                                content {
                                  name = single_header.value.name
                                }
                              }
                              dynamic "single_query_argument" {
                                for_each = try([field_to_match.value.single_query_argument], [])
                                content {
                                  name = single_query_argument.value.name
                                }
                              }
                              dynamic "body" {
                                for_each = try([field_to_match.value.body], [])
                                content {
                                  oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                                }
                              }
                              dynamic "json_body" {
                                for_each = try([field_to_match.value.json_body], [])
                                content {
                                  match_scope               = json_body.value.match_scope
                                  invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                                  oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([json_body.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_paths = try(json_body.value.match_pattern.included_paths, null)
                                  }
                                }
                              }
                              dynamic "cookies" {
                                for_each = try([field_to_match.value.cookies], [])
                                content {
                                  match_scope       = cookies.value.match_scope
                                  oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([cookies.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                                    excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                                  }
                                }
                              }
                              dynamic "headers" {
                                for_each = try([field_to_match.value.headers], [])
                                content {
                                  match_scope       = headers.value.match_scope
                                  oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([headers.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_headers = try(headers.value.match_pattern.included_headers, null)
                                    excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                                  }
                                }
                              }
                              dynamic "ja3_fingerprint" {
                                for_each = try([field_to_match.value.ja3_fingerprint], [])
                                content {
                                  fallback_behavior = ja3_fingerprint.value.fallback_behavior
                                }
                              }
                              dynamic "header_order" {
                                for_each = try([field_to_match.value.header_order], [])
                                content {
                                  oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                                }
                              }
                            }
                          }
                          dynamic "text_transformation" {
                            for_each = try(byte_match_statement.value.text_transformation, [])
                            content {
                              priority = text_transformation.value.priority
                              type     = text_transformation.value.type
                            }
                          }
                        }
                      }

                      dynamic "geo_match_statement" {
                        for_each = try([statement.value.geo_match_statement], [])
                        content {
                          country_codes = geo_match_statement.value.country_codes
                          dynamic "forwarded_ip_config" {
                            for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                            content {
                              header_name       = forwarded_ip_config.value.header_name
                              fallback_behavior = forwarded_ip_config.value.fallback_behavior
                            }
                          }
                        }
                      }

                      dynamic "ip_set_reference_statement" {
                        for_each = try([statement.value.ip_set_reference_statement], [])
                        content {
                          arn = ip_set_reference_statement.value.arn
                          dynamic "ip_set_forwarded_ip_config" {
                            for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                            content {
                              header_name       = ip_set_forwarded_ip_config.value.header_name
                              fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                              position          = ip_set_forwarded_ip_config.value.position
                            }
                          }
                        }
                      }

                      dynamic "label_match_statement" {
                        for_each = try([statement.value.label_match_statement], [])
                        content {
                          scope = label_match_statement.value.scope
                          key   = label_match_statement.value.key
                        }
                      }
                    }
                  }
                }
              }

              dynamic "or_statement" {
                for_each = try([not_statement.value.statement.or_statement], [])
                content {
                  dynamic "statement" {
                    for_each = try(or_statement.value.statements, [])
                    content {
                      dynamic "byte_match_statement" {
                        for_each = try([statement.value.byte_match_statement], [])
                        content {
                          search_string         = byte_match_statement.value.search_string
                          positional_constraint = byte_match_statement.value.positional_constraint
                          dynamic "field_to_match" {
                            for_each = try([byte_match_statement.value.field_to_match], [])
                            content {
                              dynamic "uri_path" {
                                for_each = try([field_to_match.value.uri_path], [])
                                content {}
                              }
                              dynamic "query_string" {
                                for_each = try([field_to_match.value.query_string], [])
                                content {}
                              }
                              dynamic "method" {
                                for_each = try([field_to_match.value.method], [])
                                content {}
                              }
                              dynamic "all_query_arguments" {
                                for_each = try([field_to_match.value.all_query_arguments], [])
                                content {}
                              }
                              dynamic "single_header" {
                                for_each = try([field_to_match.value.single_header], [])
                                content {
                                  name = single_header.value.name
                                }
                              }
                              dynamic "single_query_argument" {
                                for_each = try([field_to_match.value.single_query_argument], [])
                                content {
                                  name = single_query_argument.value.name
                                }
                              }
                              dynamic "body" {
                                for_each = try([field_to_match.value.body], [])
                                content {
                                  oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                                }
                              }
                              dynamic "json_body" {
                                for_each = try([field_to_match.value.json_body], [])
                                content {
                                  match_scope               = json_body.value.match_scope
                                  invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                                  oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([json_body.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_paths = try(json_body.value.match_pattern.included_paths, null)
                                  }
                                }
                              }
                              dynamic "cookies" {
                                for_each = try([field_to_match.value.cookies], [])
                                content {
                                  match_scope       = cookies.value.match_scope
                                  oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([cookies.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                                    excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                                  }
                                }
                              }
                              dynamic "headers" {
                                for_each = try([field_to_match.value.headers], [])
                                content {
                                  match_scope       = headers.value.match_scope
                                  oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                                  match_pattern {
                                    dynamic "all" {
                                      for_each = try([headers.value.match_pattern.all], [])
                                      content {}
                                    }
                                    included_headers = try(headers.value.match_pattern.included_headers, null)
                                    excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                                  }
                                }
                              }
                              dynamic "ja3_fingerprint" {
                                for_each = try([field_to_match.value.ja3_fingerprint], [])
                                content {
                                  fallback_behavior = ja3_fingerprint.value.fallback_behavior
                                }
                              }
                              dynamic "header_order" {
                                for_each = try([field_to_match.value.header_order], [])
                                content {
                                  oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                                }
                              }
                            }
                          }
                          dynamic "text_transformation" {
                            for_each = try(byte_match_statement.value.text_transformation, [])
                            content {
                              priority = text_transformation.value.priority
                              type     = text_transformation.value.type
                            }
                          }
                        }
                      }

                      dynamic "geo_match_statement" {
                        for_each = try([statement.value.geo_match_statement], [])
                        content {
                          country_codes = geo_match_statement.value.country_codes
                          dynamic "forwarded_ip_config" {
                            for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                            content {
                              header_name       = forwarded_ip_config.value.header_name
                              fallback_behavior = forwarded_ip_config.value.fallback_behavior
                            }
                          }
                        }
                      }

                      dynamic "ip_set_reference_statement" {
                        for_each = try([statement.value.ip_set_reference_statement], [])
                        content {
                          arn = ip_set_reference_statement.value.arn
                          dynamic "ip_set_forwarded_ip_config" {
                            for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                            content {
                              header_name       = ip_set_forwarded_ip_config.value.header_name
                              fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                              position          = ip_set_forwarded_ip_config.value.position
                            }
                          }
                        }
                      }

                      dynamic "label_match_statement" {
                        for_each = try([statement.value.label_match_statement], [])
                        content {
                          scope = label_match_statement.value.scope
                          key   = label_match_statement.value.key
                        }
                      }
                    }
                  }
                }
              }

              dynamic "not_statement" {
                for_each = try([not_statement.value.statement.not_statement], [])
                content {
                  statement {
                    dynamic "byte_match_statement" {
                      for_each = try([not_statement.value.statement.byte_match_statement], [])
                      content {
                        search_string         = byte_match_statement.value.search_string
                        positional_constraint = byte_match_statement.value.positional_constraint
                        dynamic "field_to_match" {
                          for_each = try([byte_match_statement.value.field_to_match], [])
                          content {
                            dynamic "uri_path" {
                              for_each = try([field_to_match.value.uri_path], [])
                              content {}
                            }
                            dynamic "query_string" {
                              for_each = try([field_to_match.value.query_string], [])
                              content {}
                            }
                            dynamic "method" {
                              for_each = try([field_to_match.value.method], [])
                              content {}
                            }
                            dynamic "all_query_arguments" {
                              for_each = try([field_to_match.value.all_query_arguments], [])
                              content {}
                            }
                            dynamic "single_header" {
                              for_each = try([field_to_match.value.single_header], [])
                              content {
                                name = single_header.value.name
                              }
                            }
                            dynamic "single_query_argument" {
                              for_each = try([field_to_match.value.single_query_argument], [])
                              content {
                                name = single_query_argument.value.name
                              }
                            }
                            dynamic "body" {
                              for_each = try([field_to_match.value.body], [])
                              content {
                                oversize_handling = try(body.value.oversize_handling, "CONTINUE")
                              }
                            }
                            dynamic "json_body" {
                              for_each = try([field_to_match.value.json_body], [])
                              content {
                                match_scope               = json_body.value.match_scope
                                invalid_fallback_behavior = try(json_body.value.invalid_fallback_behavior, "EVALUATE_AS_STRING")
                                oversize_handling         = try(json_body.value.oversize_handling, "CONTINUE")
                                match_pattern {
                                  dynamic "all" {
                                    for_each = try([json_body.value.match_pattern.all], [])
                                    content {}
                                  }
                                  included_paths = try(json_body.value.match_pattern.included_paths, null)
                                }
                              }
                            }
                            dynamic "cookies" {
                              for_each = try([field_to_match.value.cookies], [])
                              content {
                                match_scope       = cookies.value.match_scope
                                oversize_handling = try(cookies.value.oversize_handling, "CONTINUE")
                                match_pattern {
                                  dynamic "all" {
                                    for_each = try([cookies.value.match_pattern.all], [])
                                    content {}
                                  }
                                  included_cookies = try(cookies.value.match_pattern.included_cookies, null)
                                  excluded_cookies = try(cookies.value.match_pattern.excluded_cookies, null)
                                }
                              }
                            }
                            dynamic "headers" {
                              for_each = try([field_to_match.value.headers], [])
                              content {
                                match_scope       = headers.value.match_scope
                                oversize_handling = try(headers.value.oversize_handling, "CONTINUE")
                                match_pattern {
                                  dynamic "all" {
                                    for_each = try([headers.value.match_pattern.all], [])
                                    content {}
                                  }
                                  included_headers = try(headers.value.match_pattern.included_headers, null)
                                  excluded_headers = try(headers.value.match_pattern.excluded_headers, null)
                                }
                              }
                            }
                            dynamic "ja3_fingerprint" {
                              for_each = try([field_to_match.value.ja3_fingerprint], [])
                              content {
                                fallback_behavior = ja3_fingerprint.value.fallback_behavior
                              }
                            }
                            dynamic "header_order" {
                              for_each = try([field_to_match.value.header_order], [])
                              content {
                                oversize_handling = try(header_order.value.oversize_handling, "CONTINUE")
                              }
                            }
                          }
                        }
                        dynamic "text_transformation" {
                          for_each = try(byte_match_statement.value.text_transformation, [])
                          content {
                            priority = text_transformation.value.priority
                            type     = text_transformation.value.type
                          }
                        }
                      }
                    }

                    dynamic "geo_match_statement" {
                      for_each = try([not_statement.value.statement.geo_match_statement], [])
                      content {
                        country_codes = geo_match_statement.value.country_codes
                        dynamic "forwarded_ip_config" {
                          for_each = try([geo_match_statement.value.forwarded_ip_config], [])
                          content {
                            header_name       = forwarded_ip_config.value.header_name
                            fallback_behavior = forwarded_ip_config.value.fallback_behavior
                          }
                        }
                      }
                    }

                    dynamic "ip_set_reference_statement" {
                      for_each = try([not_statement.value.statement.ip_set_reference_statement], [])
                      content {
                        arn = ip_set_reference_statement.value.arn
                        dynamic "ip_set_forwarded_ip_config" {
                          for_each = try([ip_set_reference_statement.value.ip_set_forwarded_ip_config], [])
                          content {
                            header_name       = ip_set_forwarded_ip_config.value.header_name
                            fallback_behavior = ip_set_forwarded_ip_config.value.fallback_behavior
                            position          = ip_set_forwarded_ip_config.value.position
                          }
                        }
                      }
                    }

                    dynamic "label_match_statement" {
                      for_each = try([not_statement.value.statement.label_match_statement], [])
                      content {
                        scope = label_match_statement.value.scope
                        key   = label_match_statement.value.key
                      }
                    }
                  }
                }
              }
            }
          }
        }

      }

      visibility_config {
        cloudwatch_metrics_enabled = try(rule.value.visibility_config.cloudwatch_metrics_enabled, var.web_acl_cloudwatch_enabled)
        metric_name                = try(rule.value.visibility_config.metric_name, rule.value.name)
        sampled_requests_enabled   = try(rule.value.visibility_config.sampled_requests_enabled, var.sampled_requests_enabled)
      }
    }
  }
}
