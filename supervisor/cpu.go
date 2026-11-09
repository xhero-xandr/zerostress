package main

import (
	"context"
	"sync"
	"time"
)

// The host reads how much processor time the microVM's unit has used (systemd's accounting of its cgroup), at a fixed
// interval while the run lasts. The guest has no say in it: a page that mines a coin keeps the processor busy whatever
// the guest reports. What counts as too busy is for whoever reads the numbers; here they are only recorded.
const (
	cpuTail       = 3 * time.Second
	cpuSamplesMax = 2000
)

// VMCPU is what the host measured: the processor time since the agent was ready and the wall time it took, and the same
// for the last cpuTail of the run (all of it when the run was shorter). One vCPU used all the time is TotalMs == WallMs.
type VMCPU struct {
	TotalMs    int64 `json:"total_ms"`
	WallMs     int64 `json:"wall_ms"`
	TailMs     int64 `json:"tail_ms"`
	TailWallMs int64 `json:"tail_wall_ms"`
}

type cpuSample struct {
	atMs int64
	cpu  time.Duration
}

type cpuMeter struct {
	mu      sync.Mutex
	samples []cpuSample
}

func (m *cpuMeter) add(atMs int64, cpu time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if n := len(m.samples); n > 0 && (atMs < m.samples[n-1].atMs || cpu < m.samples[n-1].cpu) {
		return // a clock or a counter that goes back is not believed
	}
	if len(m.samples) >= cpuSamplesMax {
		return
	}
	m.samples = append(m.samples, cpuSample{atMs: atMs, cpu: cpu})
}

// summary is nil with fewer than two samples: nothing to measure between.
func (m *cpuMeter) summary() *VMCPU {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := len(m.samples)
	if n < 2 {
		return nil
	}
	first, last := m.samples[0], m.samples[n-1]
	from := first
	for i := n - 1; i >= 0; i-- {
		if last.atMs-m.samples[i].atMs >= cpuTail.Milliseconds() {
			from = m.samples[i]
			break
		}
	}
	return &VMCPU{
		TotalMs:    (last.cpu - first.cpu).Milliseconds(),
		WallMs:     last.atMs - first.atMs,
		TailMs:     (last.cpu - from.cpu).Milliseconds(),
		TailWallMs: last.atMs - from.atMs,
	}
}

func (r *runExec) takeCPU(v VM) {
	if cpu, ok := v.CPUUsage(); ok {
		r.cpu.add(r.s.now(), cpu)
	}
}

// sampleCPU reads the VM's processor time until the run ends. teardown stops it before the VM is stopped.
func (r *runExec) sampleCPU(ctx context.Context, v VM) {
	defer r.cpuWG.Done()
	t := time.NewTicker(r.s.cpuEvery)
	defer t.Stop()
	r.takeCPU(v)
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.cpuStop:
			return
		case <-t.C:
			r.takeCPU(v)
		}
	}
}
