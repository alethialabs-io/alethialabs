# tf-module-acm

## ChangeLog

### v1.1.0
`subject_alternative_names` — extra names on the same certificate. The DNS validation records are
now a `for_each` over `domain_validation_options` (one record per name) instead of a single record
built from index `[0]`, and `aws_acm_certificate_validation` waits on all of them. Before this,
adding any SAN left a validation option no record satisfied, and the apply died on the validation
timeout rather than on an error naming the SAN.

### v1.0.0
Initial Version capable of generating ACM certificate for a domain hosted in r53

## Example Usage

Module Definition

---

```
module "acm" {
  for_each           = var.acm_certificates
  source             = "git::ssh://git@gitlab.alethia.com/educatedguessteam/tf-modules/tf-module-acm.git?ref=main"

  domain_name        = each.value["domain_name"]
  r53_zone_id        = each.value["r53_zone_id"]
  # Optional; every name listed here gets its own Route 53 validation record.
  subject_alternative_names = try(each.value["subject_alternative_names"], [])
}
```


Variables Example

---

```
acm_certificates = {
  alb-cert-1 = {
    domain_name = "tg1.alethia.eduguess.space"
    r53_zone_id = "Z00955992K1ILTFSNJ91B"
  }
  alb-cert-2 = {
    domain_name = "tg2.alethia.eduguess.space"
    r53_zone_id = "Z00955992K1ILTFSNJ91B"
  }
}
```
