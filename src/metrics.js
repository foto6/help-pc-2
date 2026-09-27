function emptyDuration() { return { count: 0, totalMs: 0, maxMs: 0 }; }
export class RuntimeMetrics {
  constructor(snapshot = {}) {
    this.queueLatency = { ...emptyDuration(), ...(snapshot.queueLatency ?? {}) };
    this.preflightLatency = { ...emptyDuration(), ...(snapshot.preflightLatency ?? {}) };
    this.executionLatency = { ...emptyDuration(), ...(snapshot.executionLatency ?? {}) };
    this.verificationLatency = { ...emptyDuration(), ...(snapshot.verificationLatency ?? {}) };
    this.reconciliationLatency = { ...emptyDuration(), ...(snapshot.reconciliationLatency ?? {}) };
    this.retries = snapshot.retries ?? 0;
    this.cancellations = snapshot.cancellations ?? 0;
    this.leaseExpiries = snapshot.leaseExpiries ?? 0;
    this.preflightAttempts = snapshot.preflightAttempts ?? 0;
    this.observationAttempts = snapshot.observationAttempts ?? 0;
    this.capabilityChecks = snapshot.capabilityChecks ?? 0;
    this.capabilityDrifts = snapshot.capabilityDrifts ?? 0;
    this.contextBindingAttempts = snapshot.contextBindingAttempts ?? 0;
    this.contextValidationAttempts = snapshot.contextValidationAttempts ?? 0;
    this.executionAttempts = snapshot.executionAttempts ?? 0;
    this.verificationAttempts = snapshot.verificationAttempts ?? 0;
    this.reconciliationAttempts = snapshot.reconciliationAttempts ?? 0;
    this.uncertainOutcomes = snapshot.uncertainOutcomes ?? 0;
  }
  recordDuration(name, ms) { const bucket = this[name]; if (!bucket || !Number.isFinite(ms) || ms < 0) return; bucket.count += 1; bucket.totalMs += ms; bucket.maxMs = Math.max(bucket.maxMs, ms); }
  increment(name) { if (typeof this[name] === "number") this[name] += 1; }
  snapshot() {
    const duration = (bucket) => ({ ...bucket, averageMs: bucket.count ? bucket.totalMs / bucket.count : 0 });
    return {
      queueLatency: duration(this.queueLatency), preflightLatency: duration(this.preflightLatency), executionLatency: duration(this.executionLatency), verificationLatency: duration(this.verificationLatency), reconciliationLatency: duration(this.reconciliationLatency),
      retries: this.retries, cancellations: this.cancellations, leaseExpiries: this.leaseExpiries,
      preflightAttempts: this.preflightAttempts, observationAttempts: this.observationAttempts, capabilityChecks: this.capabilityChecks, capabilityDrifts: this.capabilityDrifts,
      contextBindingAttempts: this.contextBindingAttempts, contextValidationAttempts: this.contextValidationAttempts,
      executionAttempts: this.executionAttempts, verificationAttempts: this.verificationAttempts, reconciliationAttempts: this.reconciliationAttempts, uncertainOutcomes: this.uncertainOutcomes,
    };
  }
  persisted() {
    return {
      queueLatency: { ...this.queueLatency }, preflightLatency: { ...this.preflightLatency }, executionLatency: { ...this.executionLatency }, verificationLatency: { ...this.verificationLatency }, reconciliationLatency: { ...this.reconciliationLatency },
      retries: this.retries, cancellations: this.cancellations, leaseExpiries: this.leaseExpiries,
      preflightAttempts: this.preflightAttempts, observationAttempts: this.observationAttempts, capabilityChecks: this.capabilityChecks, capabilityDrifts: this.capabilityDrifts,
      contextBindingAttempts: this.contextBindingAttempts, contextValidationAttempts: this.contextValidationAttempts,
      executionAttempts: this.executionAttempts, verificationAttempts: this.verificationAttempts, reconciliationAttempts: this.reconciliationAttempts, uncertainOutcomes: this.uncertainOutcomes,
    };
  }
}
