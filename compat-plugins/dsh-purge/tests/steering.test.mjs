import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ALL_PATCHES, applyReplacementsToText } from "../lib/core.js";

const controllerPath = new URL("../../../packages/api/session-controller/lib/index.js", import.meta.url);
const controller = readFileSync(controllerPath, "utf8");

test("patch application retains the official queue and steering paths", () => {
  assert.equal(ALL_PATCHES.some(patch => patch.id === 85 || patch.id === 86), false);
  let reapplied = controller;
  for (const patch of ALL_PATCHES) {
    const files = Array.isArray(patch.file) ? patch.file : [patch.file];
    if (files.includes("api-session-controller")) {
      reapplied = applyReplacementsToText(reapplied, patch, controllerPath.pathname).text;
    }
  }
  assert.match(reapplied, /if \(request.mode === "steer"\) agent.steer\(message\);\s+else agent.followup\(message\);/);
  assert.match(reapplied, /case "steer":\s+agent.inbox.remove\(request.itemId\);\s+agent.steer\(message\);/);
});

for (const mode of ["steer", "queue"]) {
  test(`the built prompt handler routes ${mode} to its selected delivery window`, () => {
    const body = controller.match(/if \(request.mode === "steer"\) agent.steer\(message\);\s+else agent.followup\(message\);/)?.[0];
    assert.ok(body);
    const calls = [];
    const agent = {
      steer: message => calls.push(["next-step", message]),
      followup: message => calls.push(["next-turn", message]),
    };
    const message = { id: "disposable-test-message" };
    new Function("agent", "request", "message", body)(agent, { mode }, message);
    assert.deepEqual(calls, [[mode === "steer" ? "next-step" : "next-turn", message]]);
  });
}

test("the built queue handler moves steering into the next step", () => {
  const body = controller.match(/case "steer":\s+agent.inbox.remove\(request.itemId\);\s+agent.steer\(message\);\s+break;/)?.[0];
  assert.ok(body);
  const calls = [];
  const agent = {
    inbox: { remove: id => calls.push(["remove", id]) },
    steer: message => calls.push(["next-step", message.id]),
    followup: () => assert.fail("queue steering must not wait for another turn"),
  };
  const message = { id: "disposable-test-message" };
  new Function("agent", "request", "message", `switch (request.action.kind) { ${body} }`)(
    agent, { itemId: message.id, action: { kind: "steer" } }, message,
  );
  assert.deepEqual(calls, [["remove", message.id], ["next-step", message.id]]);
});
