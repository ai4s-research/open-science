import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeveloperInstructions,
  buildTranscript,
  codexSpawnSpec,
  contentToText,
  convertTools,
  isAuthorized,
  openAIResponse,
  readOptions,
} from "./server.mjs";

test("normalizes multimodal message content without dropping text", () => {
  assert.equal(contentToText("hello"), "hello");
  assert.equal(
    contentToText([{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "x" } }]),
    "hello\n[image: x]",
  );
});

test("keeps host instructions separate from the conversation transcript", () => {
  const messages = [
    { role: "system", content: "system rule" },
    { role: "developer", content: "developer rule" },
    { role: "user", content: "question" },
  ];
  const instructions = buildDeveloperInstructions(messages);
  assert.match(instructions, /system rule/);
  assert.match(instructions, /developer rule/);
  assert.match(instructions, /read-only/);
  assert.equal(buildTranscript(messages), "<USER>\nquestion\n</USER>");
});

test("converts and deduplicates OpenAI function tools", () => {
  const tools = [
    { type: "function", function: { name: "skill", description: "Load a skill", parameters: { type: "object" } } },
    { type: "function", function: { name: "skill", description: "duplicate" } },
    { type: "other", function: { name: "ignored" } },
  ];
  assert.deepEqual(convertTools(tools), [{
    type: "function",
    name: "skill",
    description: "Load a skill",
    inputSchema: { type: "object" },
    deferLoading: false,
  }]);
});

test("maps a dynamic tool request back to Chat Completions", () => {
  const response = openAIResponse({
    type: "tool_calls",
    calls: [{ callId: "call_1", name: "skill", arguments: { name: "literature-review" } }],
  }, "codex-cli");
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.equal(response.choices[0].message.tool_calls[0].function.name, "skill");
  assert.equal(response.choices[0].message.tool_calls[0].function.arguments, '{"name":"literature-review"}');
});

test("requires an exact bearer token only when configured", () => {
  assert.equal(isAuthorized(undefined, ""), true);
  assert.equal(isAuthorized("Bearer secret", "secret"), true);
  assert.equal(isAuthorized("Bearer wrong", "secret"), false);
});

test("uses portable safe defaults and validates numeric settings", () => {
  const options = readOptions({ CODEX_BRIDGE_CWD: "." });
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.port, 17891);
  assert.equal(options.codexCommand, "codex");
  assert.throws(() => readOptions({ CODEX_BRIDGE_PORT: "70000" }), /Invalid CODEX_BRIDGE_PORT/);
});

test("launches the Windows npm wrapper through its JavaScript entry without a shell", () => {
  assert.deepEqual(codexSpawnSpec("C:\\npm\\codex.cmd", "win32", "node.exe", () => true), {
    command: "node.exe",
    args: ["C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "app-server", "--listen", "stdio://"],
  });
  assert.throws(
    () => codexSpawnSpec("C:\\custom\\codex.cmd", "win32", "node.exe", () => false),
    /Set CODEX_BRIDGE_CODEX to a native codex\.exe/,
  );
  assert.deepEqual(codexSpawnSpec("/usr/local/bin/codex", "linux"), {
    command: "/usr/local/bin/codex",
    args: ["app-server", "--listen", "stdio://"],
  });
});
