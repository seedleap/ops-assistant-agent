import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSelectedIdeas,
  parseJsonOutput,
  selectedIdeaDraftSchema,
  type Invention,
  type SelectedIdeaDraft,
} from "./contracts.js";

const kernel: Invention["kernels"][number] = {
  id: "k1", title: "Kernel", mechanicFamily: "timing", interactionPattern: "timing",
  mechanicAnchor: "warned targets become active", coreAction: "tap", gameState: "warned or active",
  playerDecision: "choose before timeout", tension: "wait for certainty or act early",
  failAndRecovery: "a miss resets one target", masteryGrowth: "learn warning order",
  variationSource: "targets shuffle", themeBinding: "theme controls target states",
  whyFun: "fast mastery", antiClone: "warning order changes the decision",
};

const selected: SelectedIdeaDraft = {
  id: "k1", title: "Idea", summary: "Summary", mechanic: "timed choice", interactionPattern: "timing",
  playerGoal: "score before timeout", playerAction: "tap", gameState: "target is warned or active",
  decision: "choose before timeout", rules: "only warned targets score", loop: "observe and resolve",
  failState: "target expires", feedback: "target flashes",
  failureRecovery: "retry", whyFun: "mastery", prototypeTest: "three loops",
  difficultyCurve: "warnings shorten twice", variationSource: "targets shuffle",
  first10Seconds: "guided target then normal loops", funRisks: "choice may feel automatic",
  bindingRationale: "theme controls target state",
  audit: {
    loopPass: true, predictionPass: true, interactionPass: true, feasibilityPass: true,
    fatalReasons: [], evidence: "complete loop", recommendedDowngrade: "none",
  },
  imagePrompt: "portrait board",
};

test("V1 red-team verdict rejects pass flags that contradict fatal reasons", () => {
  const inconsistent: SelectedIdeaDraft = {
    ...selected,
    audit: {
      ...selected.audit,
      predictionPass: false,
      fatalReasons: [],
      evidence: "signal is not visible",
    },
  };
  assert.throws(() => normalizeSelectedIdeas([inconsistent], 1, [kernel]), /verdict is inconsistent/);
});

test("V1 selection gate is derived from the converger red-team result", () => {
  const rejected: SelectedIdeaDraft = {
    ...selected,
    audit: {
      ...selected.audit,
      predictionPass: false,
      fatalReasons: ["signal is not visible"],
      evidence: "no warning",
      recommendedDowngrade: "add a warning",
    },
  };
  const [normalized] = normalizeSelectedIdeas([rejected], 1, [kernel]);
  assert.equal(normalized.gatePassed, false);
  assert.deepEqual(normalized.fatalReasons, ["signal is not visible"]);
  assert.equal(normalized.audit.predictionPass, false);
  assert.equal(normalized.audit.evidence, "no warning");
  assert.equal(normalized.audit.recommendedDowngrade, "add a warning");
});

test("V1 selection rejects duplicate mechanic and decision pairs", () => {
  const second: SelectedIdeaDraft = { ...selected, id: "k2", title: "Idea 2" };
  assert.throws(
    () => normalizeSelectedIdeas(
      [selected, second],
      2,
      [kernel, { ...kernel, id: "k2", interactionPattern: "drag-track" }],
    ),
    /duplicate mechanic and decision pairs/,
  );
});

test("V1 contracts normalize string-list fields without accepting arbitrary objects", () => {
  const normalized = selectedIdeaDraftSchema.parse({
    ...selected,
    rules: ["rule one", "rule two"],
    audit: { ...selected.audit, evidence: ["visible warning", "state changes"] },
  });
  assert.equal(normalized.rules, "rule one；rule two");
  assert.equal(normalized.audit.evidence, "visible warning；state changes");
  assert.throws(
    () => selectedIdeaDraftSchema.parse({ ...selected, rules: [{ text: "not accepted" }] }),
    /Expected string/,
  );
});

test("JSON parser accepts a fenced model response", () => {
  assert.deepEqual(parseJsonOutput("```json\n{\"ok\":true}\n```"), { ok: true });
});
