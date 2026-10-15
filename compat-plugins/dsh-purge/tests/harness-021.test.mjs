import assert from "node:assert/strict";
import { test } from "node:test";
import { rewritePromptAssembly, overlayOfficialIdentity, CWD_ONLY_SUFFIX } from "../lib/identity.js";
import { renderPrompt } from "../../../packages/core/system-prompt/lib/index.js";

for (const preset of ["standard", "liangshen"]) {
  test(`${preset} renders with the Harness 0.2.1 working-directory context`, () => {
    const directory = {
      name: "working-directory:current",
      text: 'Current working directory: "/tmp/upgrade-smoke".',
      interpolate: false,
    };
    const original = {
      sections: [{ name: "deployment:persona-suffix", text: CWD_ONLY_SUFFIX }],
      contexts: [directory],
      tools: [],
      variables: { provider: "test", model: "test" },
    };
    const result = rewritePromptAssembly(original, {
      context: { agent: { session: { header: { preset, cwd: "/tmp/upgrade-smoke" } } } },
      capabilityProtocol: false,
    });
    assert.equal(result.sections.some(section => section.name === "deployment:persona-suffix"), false);
    assert.deepEqual(result.contexts, [directory]);
    assert.doesNotThrow(() => renderPrompt(result));
    assert.equal(original.sections[0].text, CWD_ONLY_SUFFIX);
  });
}

test("legacy assemblies retain the cwd suffix", () => {
  assert.equal(overlayOfficialIdentity([])[0].text, CWD_ONLY_SUFFIX);
});

test("custom suffix text is retained alongside the working-directory context", () => {
  const section = { name: "deployment:persona-suffix", text: "Custom deployment note." };
  assert.deepEqual(overlayOfficialIdentity([section], true), [section]);
});
