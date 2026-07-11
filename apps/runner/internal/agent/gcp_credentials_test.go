// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"os"
	"testing"
)

func TestActivateGcpWIF_WritesRecipeAndCleansUp(t *testing.T) {
	cleanup, err := ActivateGcpWIF(`{"type":"external_account"}`, "my-proj")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	path := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS")
	if path == "" {
		t.Fatal("GOOGLE_APPLICATION_CREDENTIALS should be set")
	}
	if os.Getenv("GOOGLE_PROJECT") != "my-proj" {
		t.Error("GOOGLE_PROJECT should be set")
	}
	if data, _ := os.ReadFile(path); string(data) != `{"type":"external_account"}` {
		t.Error("WIF recipe should be written verbatim")
	}
	cleanup()
	if os.Getenv("GOOGLE_APPLICATION_CREDENTIALS") != "" {
		t.Error("GOOGLE_APPLICATION_CREDENTIALS should be cleared")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("WIF file should be removed after cleanup")
	}
}
