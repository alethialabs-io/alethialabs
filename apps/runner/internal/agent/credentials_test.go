// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"os"
	"testing"
)

func TestClearAssumedCredentials(t *testing.T) {
	os.Setenv("AWS_ACCESS_KEY_ID", "test-key")
	os.Setenv("AWS_SECRET_ACCESS_KEY", "test-secret")
	os.Setenv("AWS_SESSION_TOKEN", "test-token")

	ClearAssumedCredentials()

	if os.Getenv("AWS_ACCESS_KEY_ID") != "" {
		t.Error("AWS_ACCESS_KEY_ID should be cleared")
	}
	if os.Getenv("AWS_SECRET_ACCESS_KEY") != "" {
		t.Error("AWS_SECRET_ACCESS_KEY should be cleared")
	}
	if os.Getenv("AWS_SESSION_TOKEN") != "" {
		t.Error("AWS_SESSION_TOKEN should be cleared")
	}
}

func TestInt32Ptr(t *testing.T) {
	p := int32Ptr(3600)
	if p == nil {
		t.Fatal("expected non-nil pointer")
	}
	if *p != 3600 {
		t.Errorf("expected 3600, got %d", *p)
	}
}
