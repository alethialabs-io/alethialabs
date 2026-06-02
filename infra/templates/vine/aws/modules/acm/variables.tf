variable "domain_name" {
  type = string
}
variable "r53_zone_id" {
  default = ""
  description = "Route53 zone. If domain name is specified and a cert needs to be created"
}
