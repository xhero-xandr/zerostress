package main

// SlotPool is a fixed pool of network slots (zsnet slot numbers). Its size is also the concurrency limit.
// It is not safe for concurrent use: the supervisor calls it under its own lock.
type SlotPool struct {
	max  int
	used map[int]bool
}

func NewSlotPool(max int) *SlotPool { return &SlotPool{max: max, used: map[int]bool{}} }

// Acquire returns the lowest free slot, or -1 when all are taken.
func (p *SlotPool) Acquire() int {
	for n := 0; n < p.max; n++ {
		if !p.used[n] {
			p.used[n] = true
			return n
		}
	}
	return -1
}

func (p *SlotPool) Release(n int) { delete(p.used, n) }

func (p *SlotPool) InUse() int { return len(p.used) }
