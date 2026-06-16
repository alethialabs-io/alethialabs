// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import (
	"testing"
)

func TestStrPtr(t *testing.T) {
	s := strPtr("hello")
	if s == nil {
		t.Fatal("expected non-nil pointer")
	}
	if *s != "hello" {
		t.Errorf("expected 'hello', got %q", *s)
	}
}

func TestBoolPtr(t *testing.T) {
	b := boolPtr(true)
	if b == nil {
		t.Fatal("expected non-nil pointer")
	}
	if *b != true {
		t.Error("expected true")
	}
}

func TestVPCInfoStructure(t *testing.T) {
	vpc := VPCInfo{
		ID:        "vpc-12345",
		CIDR:      "10.0.0.0/16",
		Name:      "production",
		IsDefault: false,
	}

	if vpc.ID != "vpc-12345" {
		t.Errorf("unexpected ID: %s", vpc.ID)
	}
	if vpc.CIDR != "10.0.0.0/16" {
		t.Errorf("unexpected CIDR: %s", vpc.CIDR)
	}
}

func TestSubnetInfoStructure(t *testing.T) {
	subnet := SubnetInfo{
		ID:               "subnet-abc",
		CIDR:             "10.0.1.0/24",
		AvailabilityZone: "eu-west-1a",
		VpcID:            "vpc-12345",
	}

	if subnet.AvailabilityZone != "eu-west-1a" {
		t.Errorf("unexpected AZ: %s", subnet.AvailabilityZone)
	}
}
