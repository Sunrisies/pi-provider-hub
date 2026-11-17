import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProbeRequest, parseProbeReply, probeModel } from "../src/probe.ts";

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("openai chat probe targets /chat/completions with bearer auth", () => {
	const request = buildProbeRequest({
		baseUrl: "https://api.example.com/v1/",
		apiKey: "sk-test",
		api: "openai-completions",
		model: "gpt-4.1",
	});
	assert.equal(request.url, "https://api.example.com/v1/chat/completions");
	assert.equal(request.headers.authorization, "Bearer sk-test");
	const body = request.body as Record<string, unknown>;
	assert.equal(body.model, "gpt-4.1");
	assert.equal(body.stream, false);
	assert.equal(body.max_tokens, 16);
});

test("anthropic probe uses the messages endpoint and x-api-key", () => {
	const request = buildProbeRequest({
		baseUrl: "https://api.anthropic.com/v1",
		apiKey: "sk-ant",
		api: "anthropic-messages",
		model: "claude-sonnet-4-5",
	});
	assert.equal(request.url, "https://api.anthropic.com/v1/messages");
	assert.equal(request.headers["x-api-key"], "sk-ant");
	assert.equal(request.headers["anthropic-version"], "2023-06-01");
	assert.equal(request.headers.authorization, undefined);
	const body = request.body as Record<string, unknown>;
	assert.equal(body.max_tokens, 16);
});

test("responses probe uses /responses with input", () => {
	const request = buildProbeRequest({
		baseUrl: "https://api.example.com/v1",
		apiKey: "k",
		api: "openai-responses",
		model: "gpt-5",
	});
	assert.equal(request.url, "https://api.example.com/v1/responses");
	const body = request.body as Record<string, unknown>;
	assert.equal(body.input, "ping");
	assert.equal(body.max_output_tokens, 16);
});

test("google probe uses generateContent with an encoded model", () => {
	const request = buildProbeRequest({
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		apiKey: "k",
		api: "google-generative-ai",
		model: "gemini-2.5-pro",
	});
	assert.equal(
		request.url,
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
	);
	assert.equal(request.headers["x-goog-api-key"], "k");
});

test("parseProbeReply understands every response shape", () => {
	assert.equal(
		parseProbeReply("openai-completions", { choices: [{ message: { content: "pong" } }] }),
		"pong",
	);
	assert.equal(
		parseProbeReply("anthropic-messages", { content: [{ type: "text", text: "pong" }] }),
		"pong",
	);
	assert.equal(
		parseProbeReply("google-generative-ai", {
			candidates: [{ content: { parts: [{ text: "pong" }] } }],
		}),
		"pong",
	);
	assert.equal(parseProbeReply("openai-responses", { output_text: "pong" }), "pong");
	assert.equal(
		parseProbeReply("openai-responses", {
			output: [{ content: [{ type: "output_text", text: "pong" }] }],
		}),
		"pong",
	);
	assert.equal(parseProbeReply("openai-completions", {}), "");
});

test("probeModel reports success and latency without throwing", async () => {
	let calledUrl = "";
	const result = await probeModel({
		baseUrl: "https://api.example.com/v1",
		apiKey: "k",
		api: "openai-completions",
		model: "m",
		fetchImpl: async (input) => {
			calledUrl = String(input);
			return jsonResponse({ choices: [{ message: { content: "pong" } }] });
		},
	});
	assert.equal(calledUrl, "https://api.example.com/v1/chat/completions");
	assert.equal(result.ok, true);
	assert.equal(result.reply, "pong");
	assert.equal(result.status, 200);
	assert.ok(result.latencyMs >= 0);
});

test("probeModel surfaces HTTP errors with the provider message", async () => {
	const result = await probeModel({
		baseUrl: "https://api.example.com/v1",
		apiKey: "bad",
		api: "anthropic-messages",
		model: "m",
		fetchImpl: async () => jsonResponse({ error: { message: "invalid x-api-key" } }, 401),
	});
	assert.equal(result.ok, false);
	assert.equal(result.status, 401);
	assert.match(result.error ?? "", /HTTP 401: invalid x-api-key/);
});

test("probeModel maps aborts to a friendly timeout and never throws", async () => {
	const timeout = await probeModel({
		baseUrl: "https://api.example.com/v1",
		apiKey: "k",
		api: "openai-completions",
		model: "m",
		timeoutMs: 20,
		fetchImpl: (_input, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
			}),
	});
	assert.equal(timeout.ok, false);
	assert.match(timeout.error ?? "", /请求超时（20ms）/);

	const transport = await probeModel({
		baseUrl: "https://api.example.com/v1",
		apiKey: "k",
		api: "openai-completions",
		model: "m",
		fetchImpl: async () => {
			throw new Error("ECONNREFUSED");
		},
	});
	assert.equal(transport.ok, false);
	assert.match(transport.error ?? "", /ECONNREFUSED/);
});

test("probeModel retries once when the site wants max_completion_tokens", async () => {
	const bodies: Array<Record<string, unknown>> = [];
	const result = await probeModel({
		baseUrl: "https://api.example.com/v1",
		apiKey: "k",
		api: "openai-completions",
		model: "o3",
		fetchImpl: async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			bodies.push(body);
			if (body.max_tokens !== undefined) {
				return jsonResponse(
					{ error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } },
					400,
				);
			}
			return jsonResponse({ choices: [{ message: { content: "pong" } }] });
		},
	});
	assert.equal(result.ok, true);
	assert.equal(result.reply, "pong");
	assert.equal(bodies.length, 2);
	assert.equal(bodies[0]!.max_tokens, 16);
	assert.equal(bodies[1]!.max_completion_tokens, 16);
	assert.equal(bodies[1]!.max_tokens, undefined);
});

test("probeModel accepts an empty reply as success", async () => {
	const result = await probeModel({
		baseUrl: "https://api.example.com/v1",
		apiKey: "k",
		api: "openai-completions",
		model: "m",
		fetchImpl: async () => jsonResponse({ choices: [] }),
	});
	assert.equal(result.ok, true);
	assert.equal(result.reply, "");
});