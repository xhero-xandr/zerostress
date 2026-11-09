package main

import (
	"testing"
	"time"
)

func sampled(points ...[2]int64) *cpuMeter {
	m := &cpuMeter{}
	for _, p := range points {
		m.add(p[0], time.Duration(p[1])*time.Millisecond)
	}
	return m
}

// at (wall ms, cpu ms): a run that is busy for 4 s (loading), then idle for 4 s
func TestCPU_SummaryTotalsAndTheLastThreeSeconds(t *testing.T) {
	m := sampled([2]int64{1000, 500}, [2]int64{2000, 1500}, [2]int64{3000, 2500}, [2]int64{4000, 3500}, [2]int64{5000, 3600}, [2]int64{6000, 3650}, [2]int64{7000, 3700}, [2]int64{8000, 3750})
	got := m.summary()
	if got == nil {
		t.Fatal("no summary")
	}
	want := VMCPU{TotalMs: 3250, WallMs: 7000, TailMs: 150, TailWallMs: 3000}
	if *got != want {
		t.Fatalf("summary = %+v, want %+v", *got, want)
	}
}

func TestCPU_SummaryOfARunShorterThanTheTailIsTheWholeRun(t *testing.T) {
	m := sampled([2]int64{1000, 100}, [2]int64{2000, 1100})
	got := m.summary()
	if got == nil || got.TailMs != 1000 || got.TailWallMs != 1000 || got.TotalMs != 1000 || got.WallMs != 1000 {
		t.Fatalf("summary = %+v", got)
	}
}

func TestCPU_NoSummaryWithoutTwoSamples(t *testing.T) {
	if (&cpuMeter{}).summary() != nil {
		t.Fatal("a summary from nothing")
	}
	if sampled([2]int64{1000, 100}).summary() != nil {
		t.Fatal("a summary from one sample")
	}
}

func TestCPU_AClockOrACounterThatGoesBackIsNotBelieved(t *testing.T) {
	// the bad ones come last, where they would count: a clock that went back (3500 after 4000), a counter that did (100 after 900)
	m := sampled([2]int64{1000, 100}, [2]int64{2000, 500}, [2]int64{1500, 900}, [2]int64{3000, 200}, [2]int64{4000, 900}, [2]int64{3500, 950}, [2]int64{5000, 100})
	got := m.summary()
	if got == nil || got.TotalMs != 800 || got.WallMs != 3000 {
		t.Fatalf("summary = %+v (the samples that went back must be left out)", got)
	}
}

func TestCPU_SamplesAreCapped(t *testing.T) {
	m := &cpuMeter{}
	for i := int64(0); i < cpuSamplesMax+500; i++ {
		m.add(i*1000, time.Duration(i)*time.Millisecond)
	}
	m.mu.Lock()
	n := len(m.samples)
	m.mu.Unlock()
	if n != cpuSamplesMax {
		t.Fatalf("%d samples kept, want %d", n, cpuSamplesMax)
	}
}

// the host reads the VM's processor time through the whole run, and the record keeps what it saw
func TestCore_TheHostMeasuresTheVMsProcessorTime(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{`{"e":1}`, okStatus}, LineDelay: 120 * time.Millisecond, CPURate: 0.5}}, nil)
	h.start(t)
	_, v := coreTRun(t, h, "/busy")
	if v.State != StateDone {
		t.Fatalf("view = %+v", v)
	}
	if v.VMCPU == nil {
		t.Fatal("no VMCPU in the run's view")
	}
	// half a CPU for the whole run: the tail is the whole (short) run, at about half
	if v.VMCPU.WallMs < 100 || v.VMCPU.TailWallMs != v.VMCPU.WallMs {
		t.Fatalf("VMCPU = %+v", *v.VMCPU)
	}
	ratio := float64(v.VMCPU.TotalMs) / float64(v.VMCPU.WallMs)
	if ratio < 0.35 || ratio > 0.65 {
		t.Fatalf("used %.2f of a CPU, the fake uses 0.5: VMCPU = %+v", ratio, *v.VMCPU)
	}
}

func TestCore_ACPUThatCannotBeReadLeavesNoMeasure(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{`{"e":1}`, okStatus}, LineDelay: 50 * time.Millisecond}}, nil)
	h.start(t)
	_, v := coreTRun(t, h, "/unreadable")
	if v.State != StateDone || v.VMCPU != nil {
		t.Fatalf("view = %+v", v)
	}
}

func TestCPU_SystemctlAnswerIsANumberOfNanosecondsOrUnknown(t *testing.T) {
	for _, c := range []struct {
		in   string
		want time.Duration
		ok   bool
	}{
		{"1500000000\n", 1500 * time.Millisecond, true},
		{"0\n", 0, true},
		{"[not set]\n", 0, false},
		{"", 0, false},
		{"-5\n", 0, false},
		{"12 34\n", 0, false},
		{"18446744073709551615\n", 0, false}, // systemd's "no value" is the largest 64-bit number: it does not fit, so it is unknown
	} {
		got, ok := parseCPUUsage([]byte(c.in))
		if got != c.want || ok != c.ok {
			t.Fatalf("parseCPUUsage(%q) = %v, %v; want %v, %v", c.in, got, ok, c.want, c.ok)
		}
	}
}

// the last reading is taken while the VM is still up, so that a run measured every second still counts its last moments
func TestCore_TheLastReadingIsTakenBeforeTheVMStops(t *testing.T) {
	h := newHarness(t, map[string]Script{"*": {Lines: []string{`{"e":1}`, okStatus}, LineDelay: 150 * time.Millisecond, CPURate: 1}}, nil, func(d *Deps) { d.CPUEvery = time.Hour })
	h.start(t)
	_, v := coreTRun(t, h, "/long-interval")
	if v.State != StateDone || v.VMCPU == nil {
		t.Fatalf("view = %+v: with a reading only at the start and at the end there is still a measure", v)
	}
	if v.VMCPU.WallMs < 100 {
		t.Fatalf("VMCPU = %+v", *v.VMCPU)
	}
}
