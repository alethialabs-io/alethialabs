resource "aws_security_group" "worker" {
  name        = "${local.name_prefix}-sg"
  description = "Grape worker - outbound only"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "all_outbound" {
  security_group_id = aws_security_group.worker.id
  description       = "Allow all outbound (HTTPS to Trellis, git, registries, AWS APIs)"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
