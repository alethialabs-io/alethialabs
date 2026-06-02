# tf-module-acm

## ChangeLog

### v1.0.0
Initial Version capable of generating ACM certificate for a domain hosted in r53

## Example Usage

Module Definition

---

```
module "acm" {
  for_each           = var.acm_certificates
  source             = "git::ssh://git@gitlab.itgix.com/educatedguessteam/tf-modules/tf-module-acm.git?ref=main"

  domain_name        = each.value["domain_name"]
  r53_zone_id        = each.value["r53_zone_id"]
}
```


Variables Example

---

```
acm_certificates = {
  alb-cert-1 = {
    domain_name = "tg1.itgix.eduguess.space"
    r53_zone_id = "Z00955992K1ILTFSNJ91B"
  }
  alb-cert-2 = {
    domain_name = "tg2.itgix.eduguess.space"
    r53_zone_id = "Z00955992K1ILTFSNJ91B"
  }
}
```
