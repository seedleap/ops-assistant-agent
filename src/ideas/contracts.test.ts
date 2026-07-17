import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSelectedIdeas,
  parseJsonOutput,
  validateAudits,
  type Audits,
  type Invention,
  type SelectedIdea,
} from "./contracts.js";

const kernel = {
  id: "k1", title: "Kernel", mechanicFamily: "timing", interactionPattern: "timing" as const, observation: "timer",
  decision: "choose", action: "tap", stateTransition: "resolve", feedback: "pulse",
  loopContract: "four seconds", predictionContract: "one second warning",
  visibleSignal: "countdown ring", predictionWindow: "one second", nextDecision: "target moves",
  failureRecovery: "retry", whyFun: "mastery", prototypeTest: "three loops",
};
const selected: SelectedIdea = {
  id: "k1", title: "Idea", summary: "Summary", mechanic: "timed choice", interactionPattern: "timing",
  playerGoal: "score before timeout", playerAction: "tap", gameState: "target is warned or active",
  decision: "choose before timeout", rules: "only warned targets score", loop: "observe and resolve",
  failState: "target expires", feedback: "target flashes",
  failureRecovery: "retry", whyFun: "mastery", prototypeTest: "three loops",
  difficultyCurve: "warnings shorten twice", variationSource: "targets shuffle",
  first10Seconds: "guided target then normal loops", funRisks: "choice may feel automatic",
  bindingRationale: "theme controls target state", gatePassed: true, fatalReasons: [],
  audit: {
    loopPass: true, predictionPass: true, interactionPass: true, feasibilityPass: true,
    fatalReasons: [], evidence: "complete loop", recommendedDowngrade: "none",
  },
  imagePrompt: "portrait board",
};

test("audit coverage rejects missing candidates", () => {
  const kernels: Invention["kernels"] = [kernel, { ...kernel, id: "k2" }];
  const audits: Audits["audits"] = [{
    ideaId: "k1", loopPass: true, predictionPass: true, interactionPass: true,
    feasibilityPass: true, fatalReasons: [], evidence: "complete loop", recommendedDowngrade: "none",
  }];
  assert.throws(() => validateAudits(kernels, audits), /missing=k2/);
});

test("audit verdict rejects pass flags that contradict fatal reasons", () => {
  const inconsistent: Audits["audits"] = [{
    ideaId: "k1", loopPass: true, predictionPass: true, interactionPass: true,
    feasibilityPass: true, fatalReasons: ["theme mismatch"], evidence: "off brief", recommendedDowngrade: "remove theme dependency",
  }];
  assert.throws(() => validateAudits([kernel], inconsistent), /verdict is inconsistent/);
});

test("selection gate is derived from audit instead of model claims", () => {
  const audits: Audits["audits"] = [{
    ideaId: "k1", loopPass: true, predictionPass: false, interactionPass: true,
    feasibilityPass: true, fatalReasons: ["signal is not visible"], evidence: "no warning", recommendedDowngrade: "add a warning",
  }];
  const [normalized] = normalizeSelectedIdeas([selected], 1, [kernel], audits);
  assert.equal(normalized.gatePassed, false);
  assert.deepEqual(normalized.fatalReasons, ["signal is not visible"]);
  assert.equal(normalized.audit.predictionPass, false);
  assert.equal(normalized.audit.evidence, "no warning");
  assert.equal(normalized.audit.recommendedDowngrade, "add a warning");
});

test("selection rejects duplicate mechanic and decision pairs", () => {
  const second = { ...selected, id: "k2", title: "Idea 2" };
  const audits: Audits["audits"] = ["k1", "k2"].map((ideaId) => ({
    ideaId, loopPass: true, predictionPass: true, interactionPass: true,
    feasibilityPass: true, fatalReasons: [], evidence: "complete loop", recommendedDowngrade: "none",
  }));
  assert.throws(
    () => normalizeSelectedIdeas([selected, second], 2, [kernel, { ...kernel, id: "k2", interactionPattern: "drag-track" }], audits),
    /duplicate mechanic and decision pairs/,
  );
});

test("JSON parser accepts a fenced model response", () => {
  assert.deepEqual(parseJsonOutput("```json\n{\"ok\":true}\n```"), { ok: true });
});
