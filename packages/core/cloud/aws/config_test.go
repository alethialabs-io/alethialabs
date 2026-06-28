// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import (
	"context"
	"testing"
)

// TestLoadConfig table-tests the pure config-building logic in LoadConfig:
// the region is always threaded onto the resolved aws.Config, and the profile
// loader is only appended for a non-empty, non-"default" profile (a missing
// shared-config profile surfaces as an error). LoadDefaultConfig performs no
// network calls, so this exercises real behavior without mocking.
func TestLoadConfig(t *testing.T) {
	tests := []struct {
		name        string
		opts        AWSOptions
		wantRegion  string // checked only when checkRegion is true
		checkRegion bool
		wantErr     bool
	}{
		{
			name:        "region only, no profile",
			opts:        AWSOptions{Region: "eu-west-1"},
			wantRegion:  "eu-west-1",
			checkRegion: true,
			wantErr:     false,
		},
		{
			name:        "empty profile is skipped",
			opts:        AWSOptions{Region: "us-east-1", Profile: ""},
			wantRegion:  "us-east-1",
			checkRegion: true,
			wantErr:     false,
		},
		{
			name:        "default profile is skipped, not loaded",
			opts:        AWSOptions{Region: "us-west-2", Profile: "default"},
			wantRegion:  "us-west-2",
			checkRegion: true,
			wantErr:     false,
		},
		{
			name:    "missing named profile errors",
			opts:    AWSOptions{Region: "us-east-1", Profile: "alethia-nonexistent-profile-xyz"},
			wantErr: true,
		},
		{
			name:        "empty region does not error",
			opts:        AWSOptions{},
			checkRegion: false,
			wantErr:     false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := LoadConfig(context.Background(), tt.opts)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("LoadConfig(%+v) = nil error, want error", tt.opts)
				}
				return
			}
			if err != nil {
				t.Fatalf("LoadConfig(%+v) unexpected error: %v", tt.opts, err)
			}
			if tt.checkRegion && cfg.Region != tt.wantRegion {
				t.Errorf("LoadConfig(%+v) region = %q, want %q", tt.opts, cfg.Region, tt.wantRegion)
			}
		})
	}
}

// TestDerefStr table-tests the nil-safe string dereference helper used to map
// AWS SDK *string fields onto plain struct fields.
func TestDerefStr(t *testing.T) {
	hello := "hello"
	empty := ""
	tests := []struct {
		name string
		in   *string
		want string
	}{
		{name: "nil pointer yields empty string", in: nil, want: ""},
		{name: "non-empty value", in: &hello, want: "hello"},
		{name: "empty value", in: &empty, want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := derefStr(tt.in); got != tt.want {
				t.Errorf("derefStr(%v) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
