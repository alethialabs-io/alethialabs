// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"strings"
	"testing"
)

func TestFormatSuccess_ContainsSymbolAndMessage(t *testing.T) {
	result := FormatSuccess("operation completed")
	if !strings.Contains(result, SymbolSuccess) {
		t.Errorf("expected %s in output, got: %s", SymbolSuccess, result)
	}
	if !strings.Contains(result, "operation completed") {
		t.Errorf("expected message in output, got: %s", result)
	}
}

func TestFormatError_ContainsSymbolAndMessage(t *testing.T) {
	result := FormatError("something broke")
	if !strings.Contains(result, SymbolError) {
		t.Errorf("expected %s in output, got: %s", SymbolError, result)
	}
	if !strings.Contains(result, "something broke") {
		t.Errorf("expected message in output, got: %s", result)
	}
}

func TestStatusDot_Online(t *testing.T) {
	result := StatusDot("ONLINE")
	if !strings.Contains(result, SymbolOnline) {
		t.Errorf("expected online symbol, got: %s", result)
	}
}

func TestStatusDot_Active(t *testing.T) {
	result := StatusDot("ACTIVE")
	if !strings.Contains(result, SymbolOnline) {
		t.Errorf("expected online/active symbol, got: %s", result)
	}
}

func TestStatusDot_Offline(t *testing.T) {
	result := StatusDot("OFFLINE")
	if !strings.Contains(result, SymbolOffline) {
		t.Errorf("expected offline symbol, got: %s", result)
	}
}

func TestStatusDot_Draining(t *testing.T) {
	result := StatusDot("DRAINING")
	if !strings.Contains(result, SymbolPending) {
		t.Errorf("expected pending symbol, got: %s", result)
	}
}

func TestStatusDot_Creating(t *testing.T) {
	result := StatusDot("CREATING")
	if !strings.Contains(result, SymbolPending) {
		t.Errorf("expected pending symbol for CREATING, got: %s", result)
	}
}

func TestStatusDot_Failed(t *testing.T) {
	result := StatusDot("FAILED")
	if !strings.Contains(result, SymbolError) {
		t.Errorf("expected error symbol, got: %s", result)
	}
}

func TestStatusDot_Destroyed(t *testing.T) {
	result := StatusDot("DESTROYED")
	if !strings.Contains(result, SymbolDash) {
		t.Errorf("expected dash symbol, got: %s", result)
	}
}

func TestStatusDot_Unknown(t *testing.T) {
	result := StatusDot("SOMETHING_ELSE")
	if !strings.Contains(result, SymbolOffline) {
		t.Errorf("expected offline symbol for unknown status, got: %s", result)
	}
}

func TestDefaultBadge_ContainsStar(t *testing.T) {
	result := DefaultBadge()
	if !strings.Contains(result, SymbolDefault) {
		t.Errorf("expected star symbol, got: %s", result)
	}
}

func TestSymbolConstants(t *testing.T) {
	if SymbolSuccess != "✓" {
		t.Errorf("SymbolSuccess should be ✓, got %s", SymbolSuccess)
	}
	if SymbolError != "✗" {
		t.Errorf("SymbolError should be ✗, got %s", SymbolError)
	}
	if SymbolOnline != "●" {
		t.Errorf("SymbolOnline should be ●, got %s", SymbolOnline)
	}
	if SymbolOffline != "○" {
		t.Errorf("SymbolOffline should be ○, got %s", SymbolOffline)
	}
}
