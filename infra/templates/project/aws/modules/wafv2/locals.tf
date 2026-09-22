locals {
  aws_managed_waf_rule_groups_for_acl = var.aws_managed_waf_rule_groups

  effective_custom_managed_waf_rule_groups_for_acl = [
    for r in var.custom_managed_waf_rule_groups : r
    if(
      (var.web_acl_scope == "CLOUDFRONT" && contains(r.rule_group_arn, ":global/")) ||
      (var.web_acl_scope == "REGIONAL" && contains(r.rule_group_arn, ":regional/"))
    )
  ]

  # Rate limits reach the ACL two ways, and both are real: the short four-field form in
  # `rate_limit_rules` (#4320), which has its own loop in webacl.tf, and the full statement tree
  # here as `statement.rate_based_statement` for anything that needs a scope-down.
  custom_rules_for_acl = var.custom_rules
}
