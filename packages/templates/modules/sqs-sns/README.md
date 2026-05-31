# tf-module-sqs

## Versions

### v1.0.2
- Added kms_key_id in the topic definition which enables encryption at rest when set

## Example Usage


Module Definition

---

```
module "sqs" {
  source        = "git::ssh://git@gitlab.itgix.com/educatedguessteam/tf-modules/tf-module-sqs.git?ref=main"
  # In case pipeline with Token is used -> Use the below example
  #source       = "git::https://gitlab.itgix.com/educatedguessteam/tf-modules/tf-module-sqs.git?ref=v1.0.2"

  sqs_username  = var.sqs_username
  sqs_iam_role_name = var.sqs_iam_role_name
  sqs_queues    = var.sqs_queues
  sns_topics    = var.sqs_topics

  global_tags   = var.global_tags
}
```

Variables Example

---

```
sqs_username = ""
sqs_iam_role_name = ""
sqs_queues = {
  sqs-queue-0 = {
    sns_topic_name            = "sns_one"
    delay_seconds             = 0
    max_message_size          = 262144
    message_retention_seconds = 86400
    receive_wait_time_seconds = 0
    dlq_enable                = true
    dlq_max_receive_count     = 10
    dlq_delay_seconds             = 0
    dlq_max_message_size          = 262144
    dlq_message_retention_seconds = 86400
    dlq_receive_wait_time_seconds = 0

    tags = {}
  }
  sqs-queue-1 = {
    sns_topic_name            = "sns_one"
    delay_seconds             = 0
    max_message_size          = 262144
    message_retention_seconds = 86400
    receive_wait_time_seconds = 0
    dlq_enable                = false

    tags = {}
  }
}
sns_topics = {
  sns_one = {
    enable_fifo = false
    tags = {}
  }
}
```
