'use strict';

/**
 * Bounded-memory latency histogram with exact count/sum/min/max and
 * approximate percentiles (1 ms resolution up to `maxMs`, then an overflow
 * bucket). Chosen over storing every sample so the long soak profile cannot
 * grow unbounded memory — which would itself corrupt a leak measurement.
 */
class Histogram {
  constructor(maxMs = 60000) {
    this.maxMs = maxMs;
    this.buckets = new Int32Array(maxMs + 1); // index = floor(ms), clamped
    this.overflow = 0;
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = 0;
  }

  record(ms) {
    if (ms < 0) ms = 0;
    this.count += 1;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
    const idx = Math.floor(ms);
    if (idx > this.maxMs) this.overflow += 1;
    else this.buckets[idx] += 1;
  }

  percentile(p) {
    if (this.count === 0) return 0;
    const target = Math.ceil((p / 100) * this.count);
    let cumulative = 0;
    for (let i = 0; i <= this.maxMs; i += 1) {
      cumulative += this.buckets[i];
      if (cumulative >= target) return i;
    }
    // Everything above maxMs lands here; report the observed max.
    return Math.round(this.max);
  }

  get avg() {
    return this.count === 0 ? 0 : this.sum / this.count;
  }

  summary() {
    return {
      count: this.count,
      min: this.count === 0 ? 0 : Math.round(this.min),
      avg: Math.round(this.avg * 10) / 10,
      p50: this.percentile(50),
      p90: this.percentile(90),
      p95: this.percentile(95),
      p99: this.percentile(99),
      max: Math.round(this.max),
      overflow: this.overflow,
    };
  }
}

/** Aggregates counters and per-group latency histograms for a run. */
class Metrics {
  constructor() {
    this.overall = new Histogram();
    this.groups = new Map(); // label -> Histogram
    this.requests = 0;
    this.errors = 0;
    this.statusClasses = new Map(); // "2xx" -> n
    this.errorSamples = new Map(); // reason -> count (capped variety)
    this.startedAt = 0;
    this.endedAt = 0;
  }

  group(label) {
    let h = this.groups.get(label);
    if (!h) {
      h = new Histogram();
      this.groups.set(label, h);
    }
    return h;
  }

  record(label, ms, statusCode, ok, reason) {
    this.requests += 1;
    this.overall.record(ms);
    this.group(label).record(ms);
    const cls = `${Math.floor((statusCode || 0) / 100) || 'x'}xx`;
    this.statusClasses.set(cls, (this.statusClasses.get(cls) ?? 0) + 1);
    if (!ok) {
      this.errors += 1;
      const key = reason || `${statusCode}`;
      if (this.errorSamples.size < 40 || this.errorSamples.has(key)) {
        this.errorSamples.set(key, (this.errorSamples.get(key) ?? 0) + 1);
      }
    }
  }

  get durationSec() {
    const end = this.endedAt || Date.now();
    return Math.max(0.001, (end - this.startedAt) / 1000);
  }

  get errorRate() {
    return this.requests === 0 ? 0 : this.errors / this.requests;
  }

  get rps() {
    return this.requests / this.durationSec;
  }

  toJSON() {
    const groups = {};
    for (const [label, h] of this.groups) groups[label] = h.summary();
    return {
      requests: this.requests,
      errors: this.errors,
      errorRate: Math.round(this.errorRate * 100000) / 100000,
      durationSec: Math.round(this.durationSec * 100) / 100,
      rps: Math.round(this.rps * 100) / 100,
      statusClasses: Object.fromEntries(this.statusClasses),
      overall: this.overall.summary(),
      groups,
      errorSamples: Object.fromEntries(this.errorSamples),
    };
  }
}

module.exports = { Histogram, Metrics };
