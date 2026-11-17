import assert from "node:assert/strict";
import { test } from "node:test";
import { inferContextWindow, inferReasoning, inferVision, toStoredModel } from "../src/infer.ts";

test("inferContextWindow uses size suffixes", () => {
	assert.equal(inferContextWindow("qwen2.5-72b-instruct-128k"), 131072);
	assert.equal(inferContextWindow("some-model-256k"), 262144);
	assert.equal(inferContextWindow("model-1m"), 1000000);
	assert.equal(inferContextWindow("model-200k"), 200000);
	assert.equal(inferContextWindow("model-8b"), 131072);
});

test("inferContextWindow falls back to model families and the default", () => {
	assert.equal(inferContextWindow("claude-sonnet-4"), 200000);
	assert.equal(inferContextWindow("gemini-2.5-pro"), 1048576);
	assert.equal(inferContextWindow("deepseek-chat"), 131072);
	assert.equal(inferContextWindow("gpt-4.1-mini"), 131072);
	assert.equal(inferContextWindow("llama-3.3-70b"), 131072);
});

test("inferVision", () => {
	assert.equal(inferVision("gpt-4o"), true);
	assert.equal(inferVision("claude-3-5-sonnet"), true);
	assert.equal(inferVision("gemini-2.5-flash"), true);
	assert.equal(inferVision("qwen2.5-vl-72b"), true);
	assert.equal(inferVision("llava-1.6"), true);
	assert.equal(inferVision("deepseek-chat"), false);
	assert.equal(inferVision("text-davinci-003"), false);
});

test("inferReasoning", () => {
	assert.equal(inferReasoning("o3-mini"), true);
	assert.equal(inferReasoning("deepseek-r1"), true);
	assert.equal(inferReasoning("gpt-5"), true);
	assert.equal(inferReasoning("gpt-5-chat"), false);
	assert.equal(inferReasoning("qwen3-32b-thinking"), true);
	assert.equal(inferReasoning("gpt-4o"), false);
});

test("toStoredModel prefers discovered metadata and applies defaults", () => {
	const discovered = toStoredModel({
		id: "m1",
		contextWindow: 64000,
		maxTokens: 4096,
		vision: false,
		reasoning: true,
	});
	assert.equal(discovered.contextWindow, 64000);
	assert.equal(discovered.maxTokens, 4096);
	assert.deepEqual(discovered.input, ["text"]);
	assert.equal(discovered.reasoning, true);
	assert.deepEqual(discovered.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

	const inferred = toStoredModel({ id: "gemini-2.5-pro" });
	assert.equal(inferred.contextWindow, 1048576);
	assert.deepEqual(inferred.input, ["text", "image"]);
	// gemini-2.5 is a thinking family, so reasoning models get the larger cap.
	assert.equal(inferred.maxTokens, 16384);

	const plain = toStoredModel({ id: "gpt-4o" });
	assert.equal(plain.reasoning, false);
	assert.equal(plain.maxTokens, 8192);

	const reasoning = toStoredModel({ id: "o4-mini" });
	assert.equal(reasoning.maxTokens, 16384);
	assert.equal(reasoning.reasoning, true);
});