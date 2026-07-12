// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"sync"
)

// cancelRegistry maps in-flight job ids to the CancelFunc of their per-job context, so a
// cancel signal pushed over the wake stream (a typed {"type":"cancel","job_id":…} event)
// can tear the RIGHT job down mid-flight. It also remembers which jobs were cancelled (so
// the runner posts CANCELLED, not FAILED, when the cancelled context surfaces as an error)
// and which of those may have left orphaned cloud resources (a mid-apply cancel).
//
// All state is mutex-guarded: the wake goroutine calls cancel() while the claim goroutine
// register()s / unregister()s concurrently.
type cancelRegistry struct {
	mu        sync.Mutex
	cancels   map[string]context.CancelFunc
	cancelled map[string]bool
	orphans   map[string]bool
}

// newCancelRegistry builds an empty registry.
func newCancelRegistry() *cancelRegistry {
	return &cancelRegistry{
		cancels:   map[string]context.CancelFunc{},
		cancelled: map[string]bool{},
		orphans:   map[string]bool{},
	}
}

// register records a job's cancel function for the duration of its execution.
func (r *cancelRegistry) register(jobID string, cancel context.CancelFunc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cancels[jobID] = cancel
}

// unregister drops a job's cancel function (called when the job finishes). It intentionally
// leaves the cancelled/orphan flags in place until reap() so the completion path can still
// read them after the cancel function is gone.
func (r *cancelRegistry) unregister(jobID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.cancels, jobID)
}

// reap clears every trace of a job once its status has been posted, so the maps don't grow
// unboundedly across a runner's lifetime.
func (r *cancelRegistry) reap(jobID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.cancels, jobID)
	delete(r.cancelled, jobID)
	delete(r.orphans, jobID)
}

// cancel marks the job cancelled and invokes its cancel function (if the job is running).
// Returns true when a live job was cancelled; false when it wasn't running here (e.g. a
// QUEUED job the console cancels DB-only, or an already-finished job).
func (r *cancelRegistry) cancel(jobID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cancelled[jobID] = true
	if cancel, ok := r.cancels[jobID]; ok {
		cancel()
		return true
	}
	return false
}

// wasCancelled reports whether the job was cancelled via a cancel signal (as opposed to
// failing on its own or timing out).
func (r *cancelRegistry) wasCancelled(jobID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cancelled[jobID]
}

// markOrphanRisk records that a cancelled job was killed AFTER apply started, so cloud
// resources may exist outside tofu state (an operator must reconcile).
func (r *cancelRegistry) markOrphanRisk(jobID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.orphans[jobID] = true
}

// orphanRisk reports whether the cancelled job may have left orphaned cloud resources.
func (r *cancelRegistry) orphanRisk(jobID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.orphans[jobID]
}
