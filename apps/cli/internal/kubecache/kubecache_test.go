// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !windows

package kubecache

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const (
	cid    = "33333333-3333-4333-8333-333333333333"
	canary = "CANARY-kubecache-token-7c1f"
)

// newCache opens a cache in a fresh temp dir.
func newCache(t *testing.T) *Cache {
	t.Helper()
	c, err := Open(filepath.Join(t.TempDir(), "kubecache"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return c
}

// entry builds a readonly entry expiring in d.
func entry(d time.Duration) Entry {
	return Entry{ClusterID: cid, Tier: types.KubeconfigMintTierReadonly, Token: canary, ExpiresAt: time.Now().Add(d).UTC().Truncate(time.Second)}
}

func TestOpen_CreatesAPrivateDirectory(t *testing.T) {
	c := newCache(t)
	fi, err := os.Stat(c.Dir())
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o700 {
		t.Errorf("dir mode %#o, want 0700", fi.Mode().Perm())
	}
}

func TestOpen_TightensAnOpenDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "kc")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir); err != nil {
		t.Fatalf("Open: %v", err)
	}
	fi, _ := os.Stat(dir)
	if fi.Mode().Perm() != 0o700 {
		t.Errorf("dir mode %#o after Open, want 0700", fi.Mode().Perm())
	}
}

func TestOpen_RefusesWhatIsNotADirectory(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.Mkdir(real, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(link); !errors.Is(err, ErrInsecure) {
		t.Errorf("a symlinked cache dir must be refused, got %v", err)
	}

	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(filepath.Join(file, "sub")); err == nil {
		t.Error("a dir under a file cannot be created; want an error")
	}
}

func TestDefaultDir_IsUnderTheConfigDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)
	dir, err := DefaultDir()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(dir, filepath.Join("alethia", "kubecache")) || !strings.HasPrefix(dir, home) {
		t.Errorf("DefaultDir = %s", dir)
	}

	t.Setenv("HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	if _, err := DefaultDir(); err == nil {
		t.Error("with no HOME there is no config dir; want an error")
	}
}

func TestPutGet_RoundTripsAt0600(t *testing.T) {
	c := newCache(t)
	want := entry(time.Hour)
	if err := c.Put(want); err != nil {
		t.Fatalf("Put: %v", err)
	}
	fi, err := os.Stat(filepath.Join(c.Dir(), cid+".readonly.json"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("entry mode %#o, want 0600", fi.Mode().Perm())
	}
	got, err := c.Get(cid, types.KubeconfigMintTierReadonly)
	if err != nil || got == nil {
		t.Fatalf("Get: %v %v", got, err)
	}
	if got.Token != canary || !got.ExpiresAt.Equal(want.ExpiresAt) {
		t.Errorf("got %v", got)
	}
	// The other tier is a different key.
	if other, err := c.Get(cid, types.KubeconfigMintTierAdmin); other != nil || err != nil {
		t.Errorf("admin tier must miss, got %v %v", other, err)
	}
	// No temp file is left behind.
	files, _ := os.ReadDir(c.Dir())
	for _, f := range files {
		if strings.HasSuffix(f.Name(), ".tmp") {
			t.Errorf("temp file left behind: %s", f.Name())
		}
	}
}

func TestGet_MissIsNil(t *testing.T) {
	c := newCache(t)
	if e, err := c.Get(cid, types.KubeconfigMintTierReadonly); e != nil || err != nil {
		t.Errorf("miss: %v %v", e, err)
	}
}

// TestGet_RefusesAGroupOrWorldReadableFile is the permission check: a credential others could read
// is an error, never a hit and never a silent miss.
func TestGet_RefusesAGroupOrWorldReadableFile(t *testing.T) {
	for _, mode := range []os.FileMode{0o640, 0o604, 0o644, 0o660} {
		c := newCache(t)
		if err := c.Put(entry(time.Hour)); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(c.Dir(), cid+".readonly.json")
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
		e, err := c.Get(cid, types.KubeconfigMintTierReadonly)
		if !errors.Is(err, ErrInsecure) || e != nil {
			t.Errorf("mode %#o: want ErrInsecure, got %v %v", mode, e, err)
		}
		if err != nil && strings.Contains(err.Error(), canary) {
			t.Errorf("the refusal quotes the token: %v", err)
		}
	}
}

func TestGet_RefusesASymlink(t *testing.T) {
	c := newCache(t)
	target := filepath.Join(t.TempDir(), "elsewhere.json")
	if err := os.WriteFile(target, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(c.Dir(), cid+".readonly.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Get(cid, types.KubeconfigMintTierReadonly); !errors.Is(err, ErrInsecure) {
		t.Errorf("want ErrInsecure for a symlink, got %v", err)
	}
}

func TestGet_UnreadableFileIsAnError(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a 0000 file")
	}
	c := newCache(t)
	if err := c.Put(entry(time.Hour)); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(c.Dir(), cid+".readonly.json")
	if err := os.Chmod(path, 0o000); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Get(cid, types.KubeconfigMintTierReadonly); err == nil || errors.Is(err, ErrInsecure) {
		t.Errorf("want an open error, got %v", err)
	}

	// A directory the cache cannot stat into is an error too, not a miss.
	if err := os.Chmod(c.Dir(), 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(c.Dir(), 0o700) })
	if _, err := c.Get(cid, types.KubeconfigMintTierReadonly); err == nil {
		t.Error("want a stat error")
	}
}

// TestGet_AnUnusableEntryIsAMiss: anything that is not an entry this package wrote for this key is
// treated as absent, so the next Put replaces it.
func TestGet_AnUnusableEntryIsAMiss(t *testing.T) {
	cases := map[string]string{
		"not json":      `{`,
		"other cluster": `{"cluster_id":"44444444-4444-4444-8444-444444444444","tier":"readonly","token":"t","expires_at":"2030-01-01T00:00:00Z"}`,
		"other tier":    `{"cluster_id":"` + cid + `","tier":"admin","token":"t","expires_at":"2030-01-01T00:00:00Z"}`,
		"no token":      `{"cluster_id":"` + cid + `","tier":"readonly","token":"","expires_at":"2030-01-01T00:00:00Z"}`,
		"no expiry":     `{"cluster_id":"` + cid + `","tier":"readonly","token":"t"}`,
		"oversized":     `{"pad":"` + strings.Repeat("x", maxFileBytes) + `"}`,
	}
	for name, body := range cases {
		c := newCache(t)
		if err := os.WriteFile(filepath.Join(c.Dir(), cid+".readonly.json"), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if e, err := c.Get(cid, types.KubeconfigMintTierReadonly); e != nil || err != nil {
			t.Errorf("%s: want a miss, got %v %v", name, e, err)
		}
	}
}

func TestKeys_RefuseWhatCannotNameAFile(t *testing.T) {
	c := newCache(t)
	for _, id := range []string{"", "../etc", "33333333-3333-4333-8333-33333333333G", "ABCDEF01-3333-4333-8333-333333333333"} {
		if _, err := c.Get(id, types.KubeconfigMintTierReadonly); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("Get(%q): %v", id, err)
		}
		if _, _, err := c.Profile(id); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("Profile(%q): %v", id, err)
		}
		if _, err := c.Lock(context.Background(), id); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("Lock(%q): %v", id, err)
		}
	}
	if _, err := c.Get(cid, "root"); !errors.Is(err, ErrInvalidKey) {
		t.Errorf("unknown tier: %v", err)
	}
	if err := c.Put(Entry{ClusterID: cid, Tier: "root", Token: "t", ExpiresAt: time.Now()}); !errors.Is(err, ErrInvalidKey) {
		t.Errorf("Put unknown tier: %v", err)
	}
	if err := c.Put(Entry{ClusterID: cid, Tier: types.KubeconfigMintTierAdmin}); err == nil {
		t.Error("Put with no token must be refused")
	}
}

// TestFreshAt_TheSixtySecondSkew pins the boundary: exactly MinRemaining left is served, one second
// less is not.
func TestFreshAt_TheSixtySecondSkew(t *testing.T) {
	now := time.Date(2026, 10, 2, 10, 0, 0, 0, time.UTC)
	cases := map[time.Duration]bool{
		time.Hour:                      true,
		61 * time.Second:               true,
		60 * time.Second:               true,
		59 * time.Second:               false,
		0:                              false,
		-time.Minute:                   false,
		MinRemaining - time.Nanosecond: false,
	}
	for left, want := range cases {
		e := Entry{ExpiresAt: now.Add(left)}
		if got := e.FreshAt(now); got != want {
			t.Errorf("FreshAt with %v left = %v, want %v", left, got, want)
		}
	}
}

// TestEntry_FormatRedactsTheToken: no verb prints the credential.
func TestEntry_FormatRedactsTheToken(t *testing.T) {
	e := entry(time.Hour)
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q", "%x"} {
		out := fmt.Sprintf(verb, e)
		if strings.Contains(out, canary) {
			t.Errorf("%s printed the token: %s", verb, out)
		}
		if !strings.Contains(out, "<redacted>") {
			t.Errorf("%s: %s", verb, out)
		}
	}
	if out := fmt.Sprintf("%v", &e); strings.Contains(out, canary) {
		t.Errorf("pointer printed the token: %s", out)
	}
}

func TestProfile_RoundTripAndRefusals(t *testing.T) {
	c := newCache(t)
	if _, ok, err := c.Profile(cid); ok || err != nil {
		t.Fatalf("no profile yet: %v %v", ok, err)
	}
	want := Profile{ClusterID: cid, Tier: types.KubeconfigMintTierAdmin, TTLSeconds: 7200, OrgID: "org-1"}
	if err := c.SetProfile(want); err != nil {
		t.Fatalf("SetProfile: %v", err)
	}
	got, ok, err := c.Profile(cid)
	if err != nil || !ok || got != want {
		t.Fatalf("Profile = %+v %v %v", got, ok, err)
	}
	fi, _ := os.Stat(filepath.Join(c.Dir(), cid+".profile.json"))
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("profile mode %#o", fi.Mode().Perm())
	}

	for name, p := range map[string]Profile{
		"bad id":   {ClusterID: "x", Tier: types.KubeconfigMintTierAdmin, TTLSeconds: 3600},
		"bad tier": {ClusterID: cid, Tier: "root", TTLSeconds: 3600},
		"bad ttl":  {ClusterID: cid, Tier: types.KubeconfigMintTierAdmin, TTLSeconds: 60},
	} {
		if err := c.SetProfile(p); err == nil {
			t.Errorf("%s: want a refusal", name)
		}
	}

	// An unusable profile on disk is absent, not an error.
	for _, body := range []string{`{`, `{"cluster_id":"` + cid + `","tier":"admin","ttl_seconds":5}`} {
		if err := os.WriteFile(filepath.Join(c.Dir(), cid+".profile.json"), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, ok, err := c.Profile(cid); ok || err != nil {
			t.Errorf("%s: want absent, got %v %v", body, ok, err)
		}
	}

	if err := os.Chmod(filepath.Join(c.Dir(), cid+".profile.json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Profile(cid); !errors.Is(err, ErrInsecure) {
		t.Errorf("a world-readable profile: %v", err)
	}
}

func TestWrite_FailuresAreErrors(t *testing.T) {
	c := newCache(t)
	// The target name is a non-empty directory: the rename cannot replace it.
	blocker := filepath.Join(c.Dir(), cid+".readonly.json")
	if err := os.MkdirAll(filepath.Join(blocker, "x"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := c.Put(entry(time.Hour)); err == nil || !strings.Contains(err.Error(), "replace") {
		t.Errorf("rename over a directory: %v", err)
	}
	// The directory is gone: no temp file can be created.
	if err := os.RemoveAll(c.Dir()); err != nil {
		t.Fatal(err)
	}
	if err := c.Put(entry(time.Hour)); err == nil || !strings.Contains(err.Error(), "temp file") {
		t.Errorf("missing dir: %v", err)
	}
	if _, err := c.Lock(context.Background(), cid); err == nil {
		t.Error("Lock in a missing dir must fail")
	}
}

// TestLock_ExcludesAndTimesOut: a held lock makes a second taker wait, and give up when its context
// ends; once released it can be taken.
func TestLock_ExcludesAndTimesOut(t *testing.T) {
	c := newCache(t)
	unlock, err := c.Lock(context.Background(), cid)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*lockRetry)
	defer cancel()
	if _, err := c.Lock(ctx, cid); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("a held lock must time out, got %v", err)
	}
	unlock()
	unlock2, err := c.Lock(context.Background(), cid)
	if err != nil {
		t.Fatalf("after release: %v", err)
	}
	unlock2()
	fi, _ := os.Stat(filepath.Join(c.Dir(), cid+".lock"))
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("lock file mode %#o", fi.Mode().Perm())
	}
}

// TestLock_SerialisesConcurrentTakers: N goroutines contending never overlap in the critical
// section.
func TestLock_SerialisesConcurrentTakers(t *testing.T) {
	c := newCache(t)
	var inside, maxInside atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			unlock, err := c.Lock(context.Background(), cid)
			if err != nil {
				t.Error(err)
				return
			}
			n := inside.Add(1)
			for {
				m := maxInside.Load()
				if n <= m || maxInside.CompareAndSwap(m, n) {
					break
				}
			}
			time.Sleep(5 * time.Millisecond)
			inside.Add(-1)
			unlock()
		}()
	}
	wg.Wait()
	if maxInside.Load() != 1 {
		t.Errorf("%d takers were inside the lock at once", maxInside.Load())
	}
}

func TestLock_ReportsALockError(t *testing.T) {
	c := newCache(t)
	// A lock path that is a directory opens read-only only; O_RDWR on it fails.
	if err := os.Mkdir(filepath.Join(c.Dir(), cid+".lock"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Lock(context.Background(), cid); err == nil || !strings.Contains(err.Error(), "open lock") {
		t.Errorf("want an open error, got %v", err)
	}
}

func TestTryLock_ClosedFileIsAnError(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "l")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	if _, err := tryLock(f); err == nil {
		t.Error("flock on a closed file must fail")
	}
}
