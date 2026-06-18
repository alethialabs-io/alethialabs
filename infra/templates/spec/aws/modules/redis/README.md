# AWS Elasticache Redis Terraform Module

AWS Elasticache Redis Terraform module. Based on:

- CloudPosse Elasticache Redis cluster module: https://registry.terraform.io/modules/cloudposse/elasticache-redis/aws/latest

## Usage

Use this module by adding a `module` configuration block, setting the `source` parameter to this repository, updating the `local_module_name` and `module_version`, then defining values for the environment variables in .tfvars files:

```hcl
module "local_module_name" {
    
  source  = "git::git@gitlab.itgix.com:rnd/app-platform/iac-modules/aws-elasticache-redis"
  version = "<latest_version>" # e.g "1.0.1"

  aws_region                 = var.aws_region
  environment                = var.environment
  product_name               = var.product_name

  vpc_id                     = var.vpc_id
  subnet_ids                 = var.subnet_ids
  cluster_size               = var.redis_cluster_size
  instance_type              = var.redis_instance_type
  automatic_failover_enabled = var.redis_automatic_failover_enabled
  engine_version             = var.redis_engine_version
  family                     = var.redis_family
  allowed_cidr_blocks        = var.redis_allowed_cidr_blocks
  allowed_security_group_ids = var.redis_allowed_security_group_ids
  s3_log_bucket_name         = aws_s3_bucket.engine_logs.id

  redis_tenants               = var.redis_tenants

}

```

**NOTE**:

## Requirements

| Name | Version |
|------|---------|
| <a name="requirement_terraform"></a> [terraform](#requirement\_terraform) | >= 1.1.9 |
| <a name="requirement_aws"></a> [aws](#requirement\_aws) | >= 4.0 |

## Providers

| Name | Version |
|------|---------|
| <a name="provider_aws"></a> [aws](#provider\_aws) | >= 4.0 |

## Modules

| Name | Source | Version |
|------|--------|---------|
| <a name="module_redis"></a> [redis](#module\_redis) | cloudposse/elasticache-redis/aws | 0.52.0 |

## Resources

| Name | Type |
|------|------|
| [aws_cloudwatch_log_group.redis](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_group) | resource |
| [aws_elasticache_user.default_user](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/elasticache_user) | resource |
| [aws_elasticache_user.iam_tenants](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/elasticache_user) | resource |
| [aws_elasticache_user_group.redis_tenants](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/elasticache_user_group) | resource |
| [aws_elasticache_user_group_association.redis_associate_users_to_tenants_group](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/elasticache_user_group_association) | resource |
| [aws_iam_policy.redis_authnz_policies](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy) | resource |
| [aws_iam_policy.s3_firehose_policy](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy) | resource |
| [aws_iam_role.firehose_role](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role) | resource |
| [aws_iam_role_policy_attachment.attach_s3_policy_to_firehose_role](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy_attachment) | resource |
| [aws_iam_role_policy_attachment.redis_attach_to_tenant](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy_attachment) | resource |
| [aws_kinesis_firehose_delivery_stream.redis](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/kinesis_firehose_delivery_stream) | resource |
| [aws_kms_key.redis](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/kms_key) | resource |
| [aws_security_group.redis_cluster_sg](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/security_group) | resource |
| [aws_caller_identity.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/caller_identity) | data source |
| [aws_iam_policy_document.firehose_s3_policy](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/iam_policy_document) | data source |
| [aws_iam_policy_document.redis_authnz_policy_documents](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/iam_policy_document) | data source |
| [aws_region.current](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/region) | data source |
| [aws_s3_bucket.engine_logs](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/s3_bucket) | data source |

## Inputs

| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_additional_security_group_ids_to_associate"></a> [additional\_security\_group\_ids\_to\_associate](#input\_additional\_security\_group\_ids\_to\_associate) | A list of IDs of additional security groups to associate with created Elasticache Redis resource. Must provide all the required access | `list(string)` | `[]` | no |
| <a name="input_allowed_cidr_blocks"></a> [allowed\_cidr\_blocks](#input\_allowed\_cidr\_blocks) | List of CIDRs allowed by the security group | `list(any)` | n/a | yes |
| <a name="input_allowed_security_group_ids"></a> [allowed\_security\_group\_ids](#input\_allowed\_security\_group\_ids) | A list of IDs of Security Groups to allow access to the security group created by this module on Redis port. | `list(string)` | `[]` | no |
| <a name="input_at_rest_encryption_enabled"></a> [at\_rest\_encryption\_enabled](#input\_at\_rest\_encryption\_enabled) | Enable encryption at rest | `bool` | `true` | no |
| <a name="input_attach_policy_to_tenant_roles"></a> [attach\_policy\_to\_tenant\_roles](#input\_attach\_policy\_to\_tenant\_roles) | Attach needed authorization policy to tenant role. 'role\_name' has to be provided in redis\_tenants map | `bool` | `true` | no |
| <a name="input_automatic_failover_enabled"></a> [automatic\_failover\_enabled](#input\_automatic\_failover\_enabled) | Automatic failover (Not available for T1/T2 instances) | `bool` | `true` | no |
| <a name="input_aws_elasticache_user_name"></a> [aws\_elasticache\_user\_name](#input\_aws\_elasticache\_user\_name) | Username for the default user. Its mandatory to have at least one default user. Change this only if you already have the default user created by other means | `string` | `"default"` | no |
| <a name="input_aws_elasticache_user_permission"></a> [aws\_elasticache\_user\_permission](#input\_aws\_elasticache\_user\_permission) | Permissions (access\_string) for the default user | `string` | `"off -@all"` | no |
| <a name="input_aws_existing_default_user"></a> [aws\_existing\_default\_user](#input\_aws\_existing\_default\_user) | Is there an existing default user | `bool` | `false` | no |
| <a name="input_aws_region"></a> [aws\_region](#input\_aws\_region) | AWS region to deploy to | `string` | n/a | yes |
| <a name="input_cloudwatch_log_group_retention_in_days"></a> [cloudwatch\_log\_group\_retention\_in\_days](#input\_cloudwatch\_log\_group\_retention\_in\_days) | Specifies the number of days you want to retain log events in the log group | `number` | `0` | no |
| <a name="input_cloudwatch_logs_enabled"></a> [cloudwatch\_logs\_enabled](#input\_cloudwatch\_logs\_enabled) | Indicates whether you want to enable or disable streaming Redis logs to Cloudwatch Logs.<br>If default 'opinionated' logging is in use, this parameter takes precedence over 'firehose\_logs\_enabled'<br>in case is set to true and log will be shipped to CloudWatch Logs. | `bool` | `true` | no |
| <a name="input_cluster_mode_enabled"></a> [cluster\_mode\_enabled](#input\_cluster\_mode\_enabled) | Flag to enable/disable creation of a native redis cluster. automatic\_failover\_enabled must be set to true. Only 1 cluster\_mode block is allowed | `bool` | `true` | no |
| <a name="input_cluster_mode_num_node_groups"></a> [cluster\_mode\_num\_node\_groups](#input\_cluster\_mode\_num\_node\_groups) | Number of node groups (shards) for this Redis replication group. Changing this number will trigger an online resizing operation before other settings modifications | `number` | `1` | no |
| <a name="input_cluster_mode_replicas_per_node_group"></a> [cluster\_mode\_replicas\_per\_node\_group](#input\_cluster\_mode\_replicas\_per\_node\_group) | Number of replica nodes in each node group. Valid values are 0 to 5. Changing this number will force a new resource | `number` | `1` | no |
| <a name="input_cluster_size"></a> [cluster\_size](#input\_cluster\_size) | Number of nodes in cluster. Ignored when cluster\_mode\_enabled == true | `number` | `1` | no |
| <a name="input_description"></a> [description](#input\_description) | Elastic cache instance description | `string` | `""` | no |
| <a name="input_elasticache_subnet_group_name"></a> [elasticache\_subnet\_group\_name](#input\_elasticache\_subnet\_group\_name) | Subnet group name for the ElastiCache instance | `string` | `""` | no |
| <a name="input_engine_version"></a> [engine\_version](#input\_engine\_version) | Redis engine version | `string` | `"7.0"` | no |
| <a name="input_environment"></a> [environment](#input\_environment) | Environment in which resources are deployed | `string` | n/a | yes |
| <a name="input_family"></a> [family](#input\_family) | Redis family | `string` | `"redis7"` | no |
| <a name="input_firehose_logs_enabled"></a> [firehose\_logs\_enabled](#input\_firehose\_logs\_enabled) | Indicates whether you want to enable or disable streaming Redis logs to kinesis firehose.<br>If default 'opinionated' logging is in use, parameter 'cloudwatch\_logs\_enabled' if set to true takes precedence<br>and logs will be shipped to CloudWatch Logs. | `bool` | `false` | no |
| <a name="input_instance_type"></a> [instance\_type](#input\_instance\_type) | Elastic cache instance type | `string` | `"cache.t3.micro"` | no |
| <a name="input_log_delivery_configuration"></a> [log\_delivery\_configuration](#input\_log\_delivery\_configuration) | The log\_delivery\_configuration block allows the streaming of Redis SLOWLOG or Redis Engine Log<br>to CloudWatch Logs or Kinesis Data Firehose. Max of 2 blocks.<br>Not specifying this variable is equivalent to use default 'Opinionated' Logging provided by this module.<br>Specifying this variable will disable the default 'opinionated' logging provided by this module.<br>CloudWatch Logs or Kinesis Data Firehose needed resources have to be provided by end user. | `list(map(any))` | `[]` | no |
| <a name="input_log_format"></a> [log\_format](#input\_log\_format) | Format type for Redis logs in  default 'opinionated' logging. One of 'text' or 'json' | `string` | `"text"` | no |
| <a name="input_multi_az_enabled"></a> [multi\_az\_enabled](#input\_multi\_az\_enabled) | Multi AZ (Automatic Failover must also be enabled. If Cluster Mode is enabled, Multi AZ is on by default, and this setting is ignored) | `bool` | `true` | no |
| <a name="input_parameter"></a> [parameter](#input\_parameter) | A list of Redis parameters to apply. Note that parameters may differ from one Redis family to another | <pre>list(object({<br>    name  = string<br>    value = string<br>  }))</pre> | `[]` | no |
| <a name="input_parameter_group_description"></a> [parameter\_group\_description](#input\_parameter\_group\_description) | Managed by Terraform | `string` | `null` | no |
| <a name="input_port"></a> [port](#input\_port) | Redis port | `number` | `6379` | no |
| <a name="input_product_name"></a> [product\_name](#input\_product\_name) | Bango platform instance (same as provided tag in default\_tags) | `string` | n/a | yes |
| <a name="input_redis_tenants"></a> [redis\_tenants](#input\_redis\_tenants) | List of tenants and relevant specs for this Redis cluster | <pre>map(object({<br>    access_string = string<br>    role_name     = string<br>  }))</pre> | `{}` | no |
| <a name="input_s3_log_bucket_name"></a> [s3\_log\_bucket\_name](#input\_s3\_log\_bucket\_name) | Name of the S3 bucket to deliver logs to in default 'opinionated' logging.<br>Needed if `s3_logs_enabled` or `firehose_logs_enabled` are set to `true` | `string` | `""` | no |
| <a name="input_s3_logs_enabled"></a> [s3\_logs\_enabled](#input\_s3\_logs\_enabled) | Indicates whether you want to stream Redis logs to S3 in default 'opinionated' logging.<br>This is requiring 'firehose\_logs\_enabled' to be set to true as well. | `bool` | `false` | no |
| <a name="input_s3_logs_prefix"></a> [s3\_logs\_prefix](#input\_s3\_logs\_prefix) | Prefix to prepend to the S3 folder name logs are delivered to in default 'opinionated' logging | `string` | `""` | no |
| <a name="input_subnet_ids"></a> [subnet\_ids](#input\_subnet\_ids) | Subnet IDs to use for this Elasticache Redis deployment | `list(string)` | `[]` | no |
| <a name="input_transit_encryption_enabled"></a> [transit\_encryption\_enabled](#input\_transit\_encryption\_enabled) | Set true to enable encryption in transit. Forced true if var.auth\_token is set | `bool` | `true` | no |
| <a name="input_vpc_id"></a> [vpc\_id](#input\_vpc\_id) | VPC to be used by Elasticache Redis cluster | `string` | n/a | yes |

## Outputs

| Name | Description |
|------|-------------|
| <a name="output_redis_engine_version_actual"></a> [redis\_engine\_version\_actual](#output\_redis\_engine\_version\_actual) | The running version of the cache engine |
| <a name="output_redis_host"></a> [redis\_host](#output\_redis\_host) | Redis hostname |
| <a name="output_redis_member_clusters"></a> [redis\_member\_clusters](#output\_redis\_member\_clusters) | Redis cluster members |
| <a name="output_redis_policy_documents_for_tenants"></a> [redis\_policy\_documents\_for\_tenants](#output\_redis\_policy\_documents\_for\_tenants) | Policy documents for Redis tenants |
| <a name="output_redis_port"></a> [redis\_port](#output\_redis\_port) | Redis port |
| <a name="output_redis_primary_endpoint_address"></a> [redis\_primary\_endpoint\_address](#output\_redis\_primary\_endpoint\_address) | Redis primary or configuration endpoint, whichever is appropriate for the given cluster mode |
| <a name="output_redis_reader_endpoint_address"></a> [redis\_reader\_endpoint\_address](#output\_redis\_reader\_endpoint\_address) | The address of the endpoint for the reader node in the replication group, if the cluster mode is disabled. |
| <a name="output_redis_replication_group_arn"></a> [redis\_replication\_group\_arn](#output\_redis\_replication\_group\_arn) | Elasticache Redis replication Group ARN |
| <a name="output_redis_replication_group_cluster_name"></a> [redis\_replication\_group\_cluster\_name](#output\_redis\_replication\_group\_cluster\_name) | Elasticache Redis cluster name |
| <a name="output_redis_security_group_id"></a> [redis\_security\_group\_id](#output\_redis\_security\_group\_id) | The ID of the created security group |
| <a name="output_redis_security_group_name"></a> [redis\_security\_group\_name](#output\_redis\_security\_group\_name) | The name of the created security group |

