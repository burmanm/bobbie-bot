/** Shared builders for core unit tests. Not imported by production code. */
import type { Finding, ProducerFinding } from "./schemas.ts";

export function producer(over: Partial<ProducerFinding> = {}): ProducerFinding {
  return {
    tag: "important",
    category: "correctness",
    locations: [{ path: "pkg/a.go", startLine: 3, endLine: 3 }],
    title: "Nil map write",
    body: "Writing to a nil map panics on every reconcile of a new datacenter.",
    evidence: [{ root: "head", path: "pkg/a.go", startLine: 3, endLine: 3, quote: "m[k] = v" }],
    traced: ["pkg/a.go:1-5"],
    assumed: [],
    mechanizable: { possible: false },
    confidence: 0.8,
    ...over,
  };
}

let seq = 0;
export function finding(over: Partial<Finding> = {}): Finding {
  seq++;
  return {
    ...producer(),
    id: `f${seq}`,
    fingerprint: `fp${seq}`,
    fingerprintVersion: 1,
    source: "reviewer:main",
    status: "proposed",
    ...over,
  };
}
