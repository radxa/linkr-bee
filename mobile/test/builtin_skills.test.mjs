import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { builtinSkillCatalog, builtinSkillsPrompt, loadBuiltinSkill } from "../src/builtin-skills.mjs";
import { createSerialAgent } from "../src/pi-agent.mjs";

test("the default context contains skill metadata, not every workflow body", () => {
  const catalog = builtinSkillCatalog();
  assert.deepEqual(catalog.map(s => s.name), ["radxa-docs", "boot-diagnosis", "network-diagnosis", "download-verification"]);
  assert.ok(builtinSkillsPrompt().length < 1500);
  for (const entry of catalog) {
    const skill = loadBuiltinSkill(entry.name);
    assert.ok(skill.content.length > 1000);
    assert.equal(skill.source, "application-builtin");
    assert.equal(skill.grantsPermission, false);
    assert.ok(!builtinSkillsPrompt().includes(skill.content));
  }
});

test("loading skills cannot import paths or mutate the built-in catalog", () => {
  for (const name of ["../../secret", "https://evil.test/skill", "unknown", "toString", "__proto__"]) {
    assert.throws(() => loadBuiltinSkill(name), /Unknown built-in/);
  }
  loadBuiltinSkill("radxa-docs").content = "changed";
  builtinSkillCatalog()[0].name = "changed";
  assert.match(loadBuiltinSkill("radxa-docs").content, /Radxa documentation workflow/);
});

test("the Pi loop loads a skill, discovers documentation and reads evidence without UART writes", async () => {
  let round = 0;
  const url = "https://docs.radxa.com/dragon/q8b/system-config/uart-debug";
  const call = (name, args) => ({ type: "toolCall", id: String(round), name, arguments: args });
  const agent = createSerialAgent({ config: { endpoint: "https://model.test/v1", model: "test" },
    device: { mode: "auto", getStatus: () => ({ sessionId: 1, connected: true }), execute: () => assert.fail("documentation must not type UART") },
    docsSearch: async args => { assert.equal(args.board, "Q8B"); return { results: [{ url }], untrusted: true }; },
    webReader: async args => { assert.equal(args.url, url); return { url, text: "Observed official UART instructions", untrusted: true }; },
    stream(model, context) {
      round++;
      let content;
      if (round === 1) {
        assert.match(getCurrentSystemPrompt(context.messages), /radxa-docs/);
        assert.ok(!getCurrentSystemPrompt(context.messages).includes("# Radxa documentation workflow"));
        content = [call("load_skill", { name: "radxa-docs" })];
      } else if (round === 2) {
        const loaded = JSON.parse(context.messages.at(-1).content[0].text);
        assert.equal(loaded.grantsPermission, false);
        assert.match(loaded.content, /imports_resolve_to/);
        content = [call("search_radxa_docs", { board: "Q8B", query: "串口" })];
      } else if (round === 3) {
        assert.equal(JSON.parse(context.messages.at(-1).content[0].text).results[0].url, url);
        content = [call("read_web_page", { url })];
      } else {
        assert.match(context.messages.at(-1).content[0].text, /Observed official UART instructions/);
        content = [{ type: "text", text: `Source: ${url}. No commands were sent.` }];
      }
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
        timestamp: Date.now(), stopReason: round < 4 ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const output = createAssistantMessageEventStream();
      output.push({ type: "done", reason: message.stopReason, message }); output.end(message); return output;
    },
  });
  await agent.prompt("查一下 Q8B 串口文档");
  assert.equal(round, 4);
});
