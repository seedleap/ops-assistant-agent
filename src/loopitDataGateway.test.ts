import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { queryLoopitData } from "./loopitDataGateway.js";

const dataFile = join(process.cwd(), "sample-data", "loopit-data.json");

test("queryLoopitData returns user projects by uid", async () => {
  const result = await queryLoopitData(dataFile, { uid: "u_demo_001" });
  assert.equal(result.ok, true);
  assert.equal(result.result?.projects?.length, 2);
  assert.equal(result.result?.projects?.[0]?.pid, "p_demo_1001");
});

test("queryLoopitData returns project consumption prompt and comments by pid", async () => {
  const result = await queryLoopitData(dataFile, {
    pid: "p_demo_1001",
    startDate: "2026-06-21",
    endDate: "2026-06-22",
    sortBy: "hot",
  });
  assert.equal(result.ok, true);
  assert.equal(result.result?.consumption?.summary.vv, 4020);
  assert.equal(result.result?.prompt?.version, 3);
  assert.equal(result.result?.comments?.[0]?.id, "c_demo_001");
});

test("queryLoopitData rejects mismatched uid and pid", async () => {
  const result = await queryLoopitData(dataFile, { uid: "u_demo_002", pid: "p_demo_1001" });
  assert.equal(result.ok, false);
  assert.match(result.error || "", /belongs to UID u_demo_001/);
});
