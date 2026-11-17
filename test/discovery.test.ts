import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DiscoveryError,
	candidateModelUrls,
	chatBaseFromModelsUrl,
	fetchModels,
	filterModels,
	isNonChatModel,
	normalizeBaseUrl,
	parseModelList,
	providerBaseUrl,
} from "../src/discovery.ts";

test("normalizeBaseUrl adds https and strips endpoint suffixes", () => {
	assert.equal(normalizeBaseUrl("api.example.com"), "https://api.example.com");
	assert.equal(normalizeBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
	assert.equal(normalizeBaseUrl("https://api.example.com/v1/chat/completions"), "https://api.example.com/v1");
	assert.equal(normalizeBaseUrl("https://api.example.com/v1/models"), "https://api.example.com/v1");
	assert.equal(normalizeBaseUrl("  https://api.example.com/v1/responses  "), "https://api.example.com/v1");
	assert.equal(normalizeBaseUrl(""), "");
});

test("candidateModelUrls prefers /v1/models for host-only URLs", () => {
	assert.deepEqual(candidateModelUrls("https://api.example.com"), [
		"https://api.example.com/v1/models",
		"https://api.example.com/models",
	]);
	assert.deepEqual(candidateModelUrls("https://api.example.com/v1"), ["https://api.example.com/v1/models"]);
	assert.deepEqual(candidateModelUrls("https://generativelanguage.googleapis.com/v1beta", "google-generative-ai"), [
		"https://generativelanguage.googleapis.com/v1beta/models",
	]);
	assert.deepEqual(candidateModelUrls("https://generativelanguage.googleapis.com", "google-generative-ai"), [
		"https://generativelanguage.googleapis.com/models",
		"https://generativelanguage.googleapis.com/v1beta/models",
	]);
});

test("isNonChatModel drops embedding and media models only", () => {
	assert.equal(isNonChatModel("text-embedding-3-small"), true);
	assert.equal(isNonChatModel("whisper-1"), true);
	assert.equal(isNonChatModel("dall-e-3"), true);
	assert.equal(isNonChatModel("gte-rerank"), true);
	assert.equal(isNonChatModel("Qwen/Qwen3-Embedding-8B"), true);
	assert.equal(isNonChatModel("gpt-4o"), false);
	assert.equal(isNonChatModel("qwen-vl-max"), false);
	assert.equal(isNonChatModel("llava-hf/llava-1.5-7b"), false);
});

test("parseModelList handles {data}, {models}, {result:{data}} and bare arrays", () => {
	const fromData = parseModelList({ object: "list", data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] });
	assert.deepEqual(
		fromData.models.map((model) => model.id),
		["gpt-4o", "gpt-4o-mini"],
	);

	const fromModels = parseModelList({ models: [{ name: "claude-3-5-sonnet-latest" }] });
	assert.deepEqual(fromModels.models.map((model) => model.id), ["claude-3-5-sonnet-latest"]);

	const fromResult = parseModelList({ result: { data: [{ id: "deepseek-chat" }] } });
	assert.deepEqual(fromResult.models.map((model) => model.id), ["deepseek-chat"]);

	const bare = parseModelList(["a-model", "b-model"]);
	assert.deepEqual(bare.models.map((model) => model.id), ["a-model", "b-model"]);
});

test("parseModelList reads OpenRouter metadata and skips non-chat entries", () => {
	const parsed = parseModelList({
		data: [
			{
				id: "anthropic/claude-sonnet-4",
				name: "Claude Sonnet 4",
				context_length: 200000,
				top_provider: { max_completion_tokens: 64000 },
				architecture: { input_modalities: ["text", "image"] },
				supported_parameters: ["reasoning", "tool_calls"],
			},
			{ id: "text-embedding-3-large" },
			{ id: "whisper-large-v3" },
			{ id: "openai/gpt-4o-mini", context_length: 128000 },
		],
	});
	assert.equal(parsed.skipped, 2);
	assert.equal(parsed.models.length, 2);
	const claude = parsed.models.find((model) => model.id === "anthropic/claude-sonnet-4")!;
	assert.equal(claude.contextWindow, 200000);
	assert.equal(claude.maxTokens, 64000);
	assert.equal(claude.vision, true);
	assert.equal(claude.reasoning, true);
	assert.equal(claude.name, "Claude Sonnet 4");
});

test("parseModelList reads Google fields and generateContent filter", () => {
	const parsed = parseModelList({
		models: [
			{
				name: "models/gemini-2.5-pro",
				displayName: "Gemini 2.5 Pro",
				inputTokenLimit: 1048576,
				outputTokenLimit: 65536,
				supportedGenerationMethods: ["generateContent", "countTokens"],
			},
			{
				name: "models/text-embedding-004",
				supportedGenerationMethods: ["embedContent"],
			},
		],
	});
	assert.equal(parsed.skipped, 1);
	assert.equal(parsed.models.length, 1);
	const model = parsed.models[0]!;
	assert.equal(model.id, "gemini-2.5-pro");
	assert.equal(model.name, "Gemini 2.5 Pro");
	assert.equal(model.contextWindow, 1048576);
	assert.equal(model.maxTokens, 65536);
});

test("parseModelList merges duplicate ids and sorts output", () => {
	const parsed = parseModelList({
		data: [
			{ id: "b-model", context_length: 32000 },
			{ id: "a-model" },
			{ id: "a-model", name: "A Model" },
		],
	});
	assert.deepEqual(
		parsed.models.map((model) => model.id),
		["a-model", "b-model"],
	);
	assert.equal(parsed.models[0]!.name, "A Model");
});

test("filterModels supports keywords, Chinese commas and -exclusions", () => {
	const models = ["claude-sonnet-4", "gpt-4o", "gpt-4o-mini", "gemini-2.5-pro", "qwen3-embedding"].map((id) => ({ id }));
	assert.deepEqual(
		filterModels(models, "").map((model) => model.id),
		models.map((model) => model.id),
	);
	assert.deepEqual(
		filterModels(models, "claude, gemini").map((model) => model.id),
		["claude-sonnet-4", "gemini-2.5-pro"],
	);
	assert.deepEqual(
		filterModels(models, "gpt，-mini").map((model) => model.id),
		["gpt-4o"],
	);
	assert.deepEqual(
		filterModels(models, "-gpt").map((model) => model.id),
		models.filter((model) => !model.id.includes("gpt")).map((model) => model.id),
	);
});

test("fetchModels sends the key with the correct headers and resolves the api", async () => {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const result = await fetchModels({
		baseUrl: "https://api.test/v1",
		apiKey: "sk-test",
		fetchImpl: async (url, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			calls.push({ url: String(url), headers });
			return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	});
	assert.equal(result.models.length, 1);
	assert.equal(result.api, "openai-completions");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, "https://api.test/v1/models");
	assert.equal(calls[0]!.headers.authorization, "Bearer sk-test");
});

test("fetchModels retries with x-api-key when bearer is rejected", async () => {
	const authSeen: string[] = [];
	const result = await fetchModels({
		baseUrl: "https://api.anthropic.test/v1",
		apiKey: "sk-ant",
		fetchImpl: async (url, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			if (headers.authorization?.startsWith("Bearer ")) {
				authSeen.push("bearer");
				return new Response("unauthorized", { status: 401 });
			}
			authSeen.push("x-api-key");
			assert.equal(headers["anthropic-version"], "2023-06-01");
			assert.ok(String(url).includes("limit=1000"));
			return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4" }] }), { status: 200 });
		},
	});
	assert.deepEqual(authSeen, ["bearer", "x-api-key"]);
	assert.equal(result.auth, "x-api-key");
	assert.equal(result.api, "anthropic-messages");
	assert.ok(result.url.includes("limit=1000"));
});

test("fetchModels throws DiscoveryError with attempts when everything fails", async () => {
	await assert.rejects(
		fetchModels({
			baseUrl: "https://api.test",
			apiKey: "sk-test",
			fetchImpl: async () => new Response("nope", { status: 404 }),
		}),
		(error: unknown) => {
			assert.ok(error instanceof DiscoveryError);
			assert.equal(error.attempts.length, 2);
			assert.ok(error.message.includes("没有从 https://api.test 获取到模型列表"));
			return true;
		},
	);
});

test("fetchModels honors an explicit api choice", async () => {
	const result = await fetchModels({
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		apiKey: "google-key",
		api: "google-generative-ai",
		fetchImpl: async (url, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			assert.equal(headers["x-goog-api-key"], "google-key");
			assert.equal(String(url), "https://generativelanguage.googleapis.com/v1beta/models");
			return new Response(
				JSON.stringify({
					models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }],
				}),
				{ status: 200 },
			);
		},
	});
	assert.equal(result.api, "google-generative-ai");
	assert.equal(result.models[0]!.id, "gemini-2.5-flash");
});

test("chatBaseFromModelsUrl strips the models suffix and query", () => {
	assert.equal(chatBaseFromModelsUrl("https://api.test/v1/models"), "https://api.test/v1");
	assert.equal(chatBaseFromModelsUrl("https://api.test/v1/models?limit=1000"), "https://api.test/v1");
	assert.equal(chatBaseFromModelsUrl("https://api.test/models/"), "https://api.test");
	assert.equal(chatBaseFromModelsUrl("https://api.test"), "https://api.test");
});

test("providerBaseUrl only promotes a bare host to the discovered versioned base", () => {
	assert.equal(providerBaseUrl("https://api.test", "https://api.test/v1/models"), "https://api.test/v1");
	assert.equal(providerBaseUrl("https://api.test/", "https://api.test/v1/models"), "https://api.test/v1");
	assert.equal(
		providerBaseUrl("https://api.test/api/v3", "https://api.test/api/v3/models"),
		"https://api.test/api/v3",
	);
	assert.equal(providerBaseUrl("https://api.test/v1", "https://api.test/v1/models"), "https://api.test/v1");
});