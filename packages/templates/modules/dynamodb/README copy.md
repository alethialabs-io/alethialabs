# AWS DynamoDB Table Module

AWS DynamoDB Table module based on the [Cloud Posse module](https://github.com/cloudposse/terraform-aws-dynamodb).


## Usage

Use this module by adding a `module` configuration block, setting the `source` parameter to this repository, updating the `local_module_name` and `module_version`, then defining values for the environment variables in .tfvars files:

```hcl
module "local_module_name" {
  source = "../../"
  version = "<latest_version>" # e.g "1.0.1"

  aws_region  = var.aws_region
  environment = var.environment
  assume_role_arn = "arn:aws:iam::${var.aws_account_id}:role/role-terraform-deployment"

  # general table configuration
  table_configuration = var.table_configuration
}

```

> **NOTE:**
>
> Setting `deletion_protection_enabled` to `true` will propagate the setting to the replicas in other regions as well if they exist.

## Cross Account Access

In order to allow cross account access, the table needs to use a custom KMS key.
Set `custom_kms_key_create` and `custom_kms_key_use` to true and put trusted principal ARNs into `trusted_principal_arns`.

You need to put KMS policy statements into the trusted principials IAM policy (usually IRSA) in addition to usual DDB policy like in the following example:
```
...
    {
      "Sid": "AllowDynamoDBReadWriteExamplesTable",
      "Effect": "Allow",
      "Action": [
        "dynamodb:DescribeTable",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:BatchWriteItem",
        "dynamodb:GetItem",
        "dynamodb:BatchGetItem",
        "dynamodb:Scan",
        "dynamodb:Query",
        "dynamodb:ConditionCheckItem"
      ],
      "Resource": [
        "arn:aws:dynamodb:eu-west-2:035664710622:table/ddb-ew2-dev-ie-example",
        "arn:aws:dynamodb:eu-west-2:035664710622:table/ddb-ew2-dev-ie-example/*"
      ]
    },
    {
      "Sid": "AllowDynamoDBKMSAccess",
      "Effect": "Allow",
      "Action": [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:DescribeKey",
        "kms:CreateGrant"
      ],
      "Condition": {
        "ForAnyValue:StringEquals": {
          "kms:ResourceAliases": "alias/ddb-ew2-dev-ie-example"
        }
      },
      "Resource": ["arn:aws:kms:eu-west-2:035664710622:key/*"]
    },
```

> **WARNING:**
>
> Disabling custom KMS key requires keeping the key around until background process re-encrypts table to default key. First only set `custom_kms_key_use = false`. Delete all backups encrypted with the custom key and check in AWS console if table status shows the AWS managed default key. Only then proceed to delete the custom KMS key with `custom_kms_key_create = false`.

> **NOTE:**
>
> Currently it is not possibly to disable a custom KMS key (reverting to KMS default key, i.e. changing `custom_kms_key_use` from `true` to `false`) with Terraform due to a [provider bug](https://github.com/hashicorp/terraform-provider-aws/issues/29811).

<!-- BEGINNING OF PRE-COMMIT-TERRAFORM DOCS HOOK -->
## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | ~> 1.1 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | >= 5.0 |
| <a name="requirement_null"></a> [null](#requirement\_null) | 3.2.1 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_aws"></a> [aws](#provider\_aws) | 5.73.0 |
| <a name="provider_null"></a> [null](#provider\_null) | 3.2.1 |

## Modules

| Name | Source | Version |
|------|--------|---------|
| <a name="module_dynamodb_kms"></a> [dynamodb\_kms](#module\_dynamodb\_kms) | ./modules/kms-dynamodb/ | n/a |
| <a name="module_dynamodb_table"></a> [dynamodb\_table](#module\_dynamodb\_table) | cloudposse/dynamodb/aws | ~> 0.34.0 |

## Resources

| Name | Type |
|------|------|
| [aws_dynamodb_resource_policy.dynamodb_table](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/dynamodb_resource_policy) | resource |
| [null_resource.replica_deletion_protection](https://registry.terraform.io/providers/hashicorp/null/3.2.1/docs/resources/resource) | resource |
| [aws_iam_policy_document.dynamodb_table](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/iam_policy_document) | data source |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_assume_role_arn"></a> [assume\_role\_arn](#input\_assume\_role\_arn) | IAM Role to assume by the local-exec provisioner to use CLI. | `string` | `""` | no |
| <a name="input_aws_region"></a> [aws\_region](#input\_aws\_region) | AWS region to deploy to | `string` | n/a | yes |
| <a name="input_environment"></a> [environment](#input\_environment) | Environment in which resources are deployed. | `string` | n/a | yes |
| <a name="input_table_configuration"></a> [table\_configuration](#input\_table\_configuration) | Values needed for the creation of a new table. For the value of the argument 'table\_name\_suffix' it should be a value that has the service name and the purpose of that table.<br/><br/>      <b>table\_type:</b> Table type regional or global. Should be used along with replicas<br/>      <b>table\_name\_suffix:</b> Suffix string that will be rendered with the table name, this is often the use for the table.<br/>      <b>hash\_key:</b> The attribute to use as the hash (partition) key. Must also be defined as an attribute.<br/>      <b>range\_key:</b> The attribute to use as the range (sort) key. Must also be defined as an attribute.<br/>      <b>hash\_key\_type:</b> Hash Key type, which must be a scalar type: S, N, or B for (S)tring, (N)umber or (B)inary data.<br/>      <b>range\_key\_type:</b> Range Key type, which must be a scalar type: S, N, or B for (S)tring, (N)umber or (B)inary data.<br/>      <b>enable\_autoscaler:</b> Flag to enable/disable DynamoDB autoscaling.<br/>      <b>dynamodb\_attributes:</b> Additional DynamoDB attributes in the form of a list of mapped values.<br/>      <b>global\_secondary\_index\_map:</b> Additional global secondary indexes in the form of a list of mapped values.<br/>      <b>local\_secondary\_index\_map:</b> Additional local secondary indexes in the form of a list of mapped values.<br/>      <b>replicas:</b> List of regions to create replica.<br/>      <b>tags\_enabled:</b> Flag to enable/disable tags.<br/>      <b>billing\_mode:</b> DynamoDB Billing mode. Can be PROVISIONED or PAY\_PER\_REQUEST.<br/>      <b>enable\_point\_in\_time\_recovery:</b> Flag to enable/disable point in time recovery.<br/>      <b>ttl\_enabled:</b> Flag to enable/disable TTL.<br/>      <b>custom\_kms\_key\_create:</b> Flag to enable/disable creation of custom KMS key (needed to allow cross account access). ⚠️ only delete a custom KMS key if it is not in use (check table KMS status in console, includes backups that need to be retained).<br/>      <b>custom\_kms\_key\_use:</b> Flag to enable/disable usage of custom KMS key (needed to allow cross account access). <br/>      <b>trusted\_principal\_arns:</b> List of principal ARNs allowed for cross account access | <pre>list(object({<br/>    table_type        = optional(string, "regional")<br/>    table_name_suffix = string<br/>    hash_key          = string<br/>    range_key         = string<br/>    hash_key_type     = string<br/>    range_key_type    = string<br/>    enable_autoscaler = bool<br/>    dynamodb_attributes = list(object({<br/>      name = string<br/>      type = string<br/>    }))<br/>    global_secondary_index_map = list(object({<br/>      hash_key           = string<br/>      name               = string<br/>      projection_type    = string<br/>      range_key          = string<br/>      non_key_attributes = list(string)<br/>      read_capacity      = number<br/>      write_capacity     = number<br/>    }))<br/>    local_secondary_index_map = list(object({<br/>      name               = string<br/>      projection_type    = string<br/>      range_key          = string<br/>      non_key_attributes = list(string)<br/>    }))<br/>    replicas                      = list(string)<br/>    tags_enabled                  = bool<br/>    billing_mode                  = string<br/>    enable_point_in_time_recovery = bool<br/>    ttl_enabled                   = bool<br/>    ttl_attribute                 = optional(string, "")<br/>    deletion_protection_enabled   = optional(bool, false)<br/>    custom_kms_key_create         = optional(bool, false)<br/>    custom_kms_key_use            = optional(bool, false)<br/>    trusted_principal_arns        = optional(list(string))<br/>  }))</pre> | n/a | yes |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_table_arn"></a> [table\_arn](#output\_table\_arn) | DynamoDB table ARN |
| <a name="output_table_id"></a> [table\_id](#output\_table\_id) | DynamoDB table ID |
| <a name="output_table_name"></a> [table\_name](#output\_table\_name) | DynamoDB table name |
<!-- END OF PRE-COMMIT-TERRAFORM DOCS HOOK -->
