function emptyDuration() { return { count: 0, totalMs: 0, maxMs: 0 }; }

export class RuntimeMetrics {
  constructor(snapshot = {}) {
    this.queueLatency = { ...emptyDuration(), ...(snapshot.queueLatency ?? {}) };
    this.executionLatency = { ...emptyDuration(), ...(snapshot.executionLatency ?? {}) };
    this.verificationLatency = { ...emptyDuration(), ...(snapshot.verificationLatency ?? {}) };
    this.retries = snapshot.retries ?? 0;
    this.cancellations = snapshot.cancellations ?? 0;
    this.leaseExpiries = snapshot.leaseExpiries ?? 0;
  }

  recordDuration(name, ms) {
    const bucket = this[name];
    if (!bucket || !Number.isFinite(ms) || ms < 0) return;
    bucket.count += 1;
    bucket.totalMs += ms;
    bucket.maxMs = Math.max(bucket.maxMs, ms);
  }

  increment(name) {
    if (typeof this[name] === "number") this[name] += 1;
  }

  snapshot() {
    const duration = (bucket) => ({
      ...bucket,
      averageMs: bucket.count ? bucket.totalMs / bucket.count : 0,
    });
    return {
      queueLatency: duration(this.queueLatency),
      executionLatency: duration(this.executionLatency),
      verificationLatency: duration(this.verificationLatency),
      retries: this.retries,
      cancellations: this.cancellations,
      leaseExpiries: this.leaseExpiries,
    };
  }

  persisted() {
    return {
      queueLatency: { ...this.queueLatency },
      executionLatency: { ...this.executionLatency },
      verificationLatency: { ...this.verificationLatency },
      retries: this.retries,
      cancellations: this.cancellations,
      leaseExpiries: this.leaseExpiries,
    };
  }
}
