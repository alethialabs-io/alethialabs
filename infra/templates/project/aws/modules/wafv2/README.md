# Terraform AWS WAFv2 Web ACL module

This module creates an AWS WAFv2 Web ACL with optional AWS managed rule groups, custom managed rule groups (by ARN), and flexible custom rules. It can optionally send WAF logs to Amazon CloudWatch Logs with a resource policy for log delivery.

You attach the Web ACL to an Application Load Balancer, API Gateway stage, or CloudFront distribution in your own configuration (for example `aws_wafv2_web_acl_association` or the distribution’s `web_acl_id`). This module only manages the ACL and its logging.

## Requirements

- [Terraform](https://www.terraform.io/) (recent 1.x recommended)
- [AWS provider](https://registry.terraform.io/providers/hashicorp/aws/latest) configured for the target account and region

## Usage

### Basic module block

Point `source` at this repository (or a path if you vendor the module). Replace placeholders with your values.

```hcl
module "waf" {
  source = "git::https://example.com/your-org/tf-module-wafv2.git?ref=main"

  pid                 = "your-project-id"
  project             = "myapp"
  env                 = "prod"
  aws_region          = "eu-west-1"
  waf_attachment_type = "alb" # used in resource naming: e.g. aws-waf-logs-<project>-<env>-alb-security

  waf_enabled     = true
  web_acl_scope   = "REGIONAL" # use CLOUDFRONT for CloudFront distributions
  waf_default_action = "allow"

  aws_managed_waf_rule_groups = [
    {
      name     = "AWSManagedRulesCommonRuleSet"
      priority = 1
      action   = "none" # "none" = use vendor defaults; "count" = count all rules in the group
    },
  ]

  custom_rules = []

  custom_managed_waf_rule_groups = []
}
```

### Outputs

| Output       | Description                                      |
|-------------|---------------------------------------------------|
| `webacl_arn` | ARN of the Web ACL, or `null` if `waf_enabled` is false |
| `webacl_id`  | ID of the Web ACL, or `null` if disabled          |

Wire `webacl_arn` into your association resource or CloudFront configuration.

### Scope and attachments

| `web_acl_scope` | Typical use                         | Managed rule / custom group ARNs |
|-----------------|-------------------------------------|----------------------------------|
| `REGIONAL`      | ALB, API Gateway, App Runner, etc.  | ARNs containing `:regional/`      |
| `CLOUDFRONT`    | CloudFront distributions            | ARNs containing `:global/`        |

`waf_attachment_type` is a label used in the Web ACL name and CloudWatch log group name (`alb`, `api-gateway`, `cloudfront`, etc.). It does not create the attachment by itself.

### AWS managed rule groups

Each element is an object with at least:

- `name` — AWS managed group name (for example `AWSManagedRulesCommonRuleSet`)
- `priority` — unique integer; lower numbers run first
- `action` — `"none"` (apply AWS defaults) or `"count"` (count every rule in the group)

Optional:

- `inspection_level` — for `AWSManagedRulesBotControlRuleSet` only (`COMMON` or `TARGETED`; default `COMMON` in the module)
- `rules_override_to_count` — list of rule names inside the group to override to **count** only

### Custom managed rule groups (ARNs)

Use `custom_managed_waf_rule_groups` to attach rule groups you already created in WAF. Each object needs `name`, `priority`, `action` (`none` or `count`), `rule_group_arn`, and `rules_override_to_count` (can be `[]`). The module keeps only ARNs that match the current `web_acl_scope` (global vs regional).

### Custom rules

`custom_rules` is a list of rules. Each rule has:

- `name` — unique rule name in the ACL
- `priority` — unique integer across **all** rules (managed groups + custom groups + custom rules)
- `action` — `allow`, `block`, `count`, `captcha`, or `challenge`
- `statement` — a map matching the Terraform `aws_wafv2_web_acl` rule `statement` schema (snake_case keys: `byte_match_statement`, `geo_match_statement`, `rate_based_statement`, `and_statement`, `or_statement`, `not_statement`, etc.)

Rate limiting is expressed with `statement.rate_based_statement` (there is no separate variable for rate rules).

Nested logical statements are supported with a practical depth limit (about two levels) as implemented in the module.

**Wrapper modules:** declare `custom_rules` with type `any` (not `list(any)`), because different rules use different statement shapes.

## Examples in this repository

| File | What it shows |
|------|----------------|
| [`examples/custom-rules.tfvars`](examples/custom-rules.tfvars) | HCL snippets for `custom_rules`: IP sets, byte match, SQLi/XSS, size limits, regex, labels, AND/OR, rate-based with scope-down, regex pattern set, captcha/challenge. Copy the `custom_rules = [...]` block into your `.tfvars` or module input. |

### Minimal custom rule (Terraform)

```hcl
custom_rules = [
  {
    name     = "block-country"
    priority = 0
    action   = "block"
    statement = {
      geo_match_statement = {
        country_codes = ["XX"]
      }
    }
  },
]
```
## Logging

When `aws_waf_logging_enabled` is true (default), the module creates a CloudWatch log group named:

`aws-waf-logs-<project>-<env>-<waf_attachment_type>-security`

and attaches WAF logging plus a log resource policy. Tune retention with `waf_log_retention_days` (default `365`).

## Variable reference (summary)

| Name | Description |
|------|-------------|
| `pid` | Project identifier (required; used by your conventions) |
| `project` | Project name |
| `env` | Environment name |
| `aws_region` | AWS region string |
| `waf_attachment_type` | Label for naming: `alb`, `api-gateway`, `cloudfront`, … |
| `waf_enabled` | Whether to create the Web ACL |
| `web_acl_scope` | `REGIONAL` or `CLOUDFRONT` |
| `web_acl_cloudwatch_enabled` | Metrics on the ACL |
| `sampled_requests_enabled` | Store sampled requests for matching rules |
| `aws_waf_logging_enabled` | CloudWatch logging for WAF |
| `waf_log_retention_days` | Log group retention |
| `waf_default_action` | `allow` or `block` when no rule matches |
| `aws_managed_waf_rule_groups` | List of AWS managed groups (see above) |
| `custom_managed_waf_rule_groups` | List of custom rule group ARNs |
| `custom_rules` | List of custom rules (see above) |

See [`variables.tf`](variables.tf) for full definitions.
