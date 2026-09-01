"use strict";

const assert = require("node:assert/strict");
const Progress = require("../src/progress-protocol.js");

function event(attempt, seq, percent, extra = {}) {
  return {
    id: "job-1",
    status: "running",
    progressVersion: Progress.VERSION,
    progressAttempt: attempt,
    progressSeq: seq,
    percent,
    ...extra
  };
}

const first = event(1, 1, 10);
assert.equal(Progress.shouldAccept(null, first), true, "first event");
assert.equal(Progress.shouldAccept(first, event(1, 2, 20)), true, "newer sequence");
assert.equal(Progress.shouldAccept(first, event(1, 1, 99)), false, "duplicate sequence");
assert.equal(Progress.shouldAccept(event(1, 5, 50), event(1, 4, 80)), false, "late sequence");

const retried = event(2, 6, 4);
assert.equal(Progress.shouldAccept(event(1, 5, 90), retried), true, "new attempt");
assert.equal(Progress.isNewAttempt(event(1, 5, 90), retried), true, "attempt reset detected");
assert.equal(Progress.stablePercent(event(1, 5, 90), retried), 4, "new attempt may reset");
assert.equal(
  Progress.shouldAccept(retried, event(1, 99, 100)),
  false,
  "late old attempt is rejected even with higher sequence"
);

assert.equal(
  Progress.stablePercent(event(2, 7, 40), event(2, 8, 35)),
  40,
  "same-attempt percentage is monotonic"
);
assert.equal(
  Progress.shouldAccept(first, { id: "job-1", percent: 100 }),
  false,
  "legacy event cannot overwrite ordered state"
);
assert.equal(
  Progress.shouldAccept({ id: "legacy", percent: 10 }, first),
  true,
  "ordered protocol upgrades legacy state"
);

console.log("progress protocol: 10 assertions passed");
