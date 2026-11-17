import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { handleProvidersCommand, type HubRuntime } from "../src/flows.ts";
import { configPath, emptyConfig, saveConfig, type HubConfig, type StoredProvider } from "../src/store.ts";

const MODELS = {
	object: "list",
	data: [
		{ id: "mock-chat-pro", context_length: 200000 },
		{ id: "mock-chat-mini", context_length: 128000 },
		{ id: "text-embedding-mock" },
	],
};

let server: Server;
let baseUrl = "";
let agentDir = "";
const tempDirs: string[] = [];

function freshAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "provider-hub-flow-"));
	tempDirs.push(dir);
	return dir;
}

before(async () => {
	agentDir = freshAgentDir();
	server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method === "GET" && url.pathname === "/v1/models") {
			if (req.headers.authorization !== "Bearer test-key") {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "invalid api key" } }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(MODELS));
			return;
		}
		if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
			if (req.headers.authorization !== "Bearer test-key") {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "invalid api key" } }));
				return;
			}
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "mock-pong" } }] }));
			});
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "not found" } }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

after(() => {
	server.close();
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
	pi: Parameters<typeof handleProvidersCommand>[0];
	ctx: Parameters<typeof handleProvidersCommand>[1];
	registered: Array<{ id: string; config: Record<string, unknown> }>;
	unregistered: string[];
	notices: string[];
}

function harness(options: {
	name: string;
	base: string;
	key: string;
	filter: string;
	apiLabel?: string;
	confirm?: boolean;
	existingProvider?: unknown;
}): Harness {
	const registered: Harness["registered"] = [];
	const unregistered: string[] = [];
	const notices: string[] = [];
	const pi = {
		registerProvider: (id: string, config: Record<string, unknown>) => registered.push({ id, config }),
		unregisterProvider: (id: string) => unregistered.push(id),
	} as unknown as Harness["pi"];
	const ctx = {
		ui: {
			input: async (title: string) => {
				if (title.includes("站点名称")) return options.name;
				if (title === "Base URL") return options.base;
				if (title.includes("API Key")) return options.key;
				if (title.includes("筛选")) return options.filter;
				throw new Error(`unexpected input: ${title}`);
			},
			select: async (title: string, options: string[]) => {
				if (title === "接口协议") return options[0]!;
				if (title.includes("选择要测试的模型")) return options[0];
				return undefined;
			},
			confirm: async () => options.confirm ?? true,
			notify: (message: string) => notices.push(message),
			setStatus: () => {},
			editor: async () => {},
		},
		modelRegistry: { getProvider: () => options.existingProvider },
		signal: undefined,
	} as unknown as Harness["ctx"];
	return { pi, ctx, registered, unregistered, notices };
}

test("add flow discovers models, saves the config and registers the provider", async () => {
	const h = harness({ name: "Mock Site", base: baseUrl, key: "test-key", filter: "" });
	const runtime: HubRuntime = { agentDir, config: emptyConfig() };

	await handleProvidersCommand(h.pi, h.ctx, runtime, "add");

	assert.equal(h.registered.length, 1);
	const registered = h.registered[0]!;
	assert.equal(registered.id, "mock-site");
	assert.equal(registered.config.baseUrl, baseUrl);
	assert.equal(registered.config.api, "openai-completions");
	assert.equal(registered.config.apiKey, "test-key");
	const models = registered.config.models as StoredProvider["models"];
	assert.deepEqual(
		models.map((model) => model.id),
		["mock-chat-mini", "mock-chat-pro"],
	);
	assert.equal(models[0]!.contextWindow, 128000);

	const saved = JSON.parse(readFileSync(configPath(agentDir), "utf8"));
	assert.equal(saved.providers.length, 1);
	assert.equal(saved.providers[0].name, "Mock Site");
	assert.equal(saved.providers[0].apiKey, "test-key");
	assert.equal(h.notices.some((notice) => notice.includes("/model")), true);

	// The extension keeps working from the saved file in a later session.
	const reloaded: HubRuntime = { agentDir, config: emptyConfig() };
	const h2 = harness({ name: "unused", base: "", key: "", filter: "" });
	await handleProvidersCommand(h2.pi, h2.ctx, reloaded, "refresh mock-site");
	assert.equal(reloaded.config.providers.length, 1);
	assert.equal(reloaded.config.providers[0]!.models.length, 2);
});

test("add flow aborts when the user cancels the preview", async () => {
	const h = harness({ name: "Cancelled Site", base: baseUrl, key: "test-key", filter: "", confirm: false });
	const runtime: HubRuntime = { agentDir, config: emptyConfig() };

	await handleProvidersCommand(h.pi, h.ctx, runtime, "add");

	assert.equal(h.registered.length, 0);
	assert.equal(runtime.config.providers.some((provider) => provider.id === "cancelled-site"), false);
});

test("add flow rejects a duplicate provider id without touching storage", async () => {
	const h = harness({ name: "Mock Site", base: baseUrl, key: "test-key", filter: "" });
	const runtime: HubRuntime = { agentDir, config: emptyConfig() };
	await handleProvidersCommand(h.pi, h.ctx, runtime, "add");
	assert.equal(h.registered.length, 0);
	assert.equal(
		h.notices.some((notice) => notice.includes("已存在")),
		true,
	);
});

test("filter keywords limit which models are registered", async () => {
	agentDir = freshAgentDir();
	const h = harness({ name: "Mini Only", base: baseUrl, key: "test-key", filter: "mini" });
	const runtime: HubRuntime = { agentDir, config: emptyConfig() };
	await handleProvidersCommand(h.pi, h.ctx, runtime, "add");
	const models = h.registered[0]!.config.models as StoredProvider["models"];
	assert.deepEqual(
		models.map((model) => model.id),
		["mock-chat-mini"],
	);
});

test("test command sends a real probe request and reports success", async () => {
	agentDir = freshAgentDir();
	const h = harness({ name: "Probe Site", base: baseUrl, key: "test-key", filter: "" });
	const runtime: HubRuntime = { agentDir, config: emptyConfig() };
	await handleProvidersCommand(h.pi, h.ctx, runtime, "add");
	assert.equal(h.registered.length, 1);

	h.notices.length = 0;
	await handleProvidersCommand(h.pi, h.ctx, runtime, "test probe-site");

	assert.equal(
		h.notices.some((notice) => notice.includes("连接成功") && notice.includes("mock-pong")),
		true,
		JSON.stringify(h.notices),
	);
});

test("test command reports an unreachable site as a failure", async () => {
	agentDir = freshAgentDir();
	const h = harness({ name: "Broken Site", base: baseUrl, key: "wrong-key", filter: "" });
	const runtime: HubRuntime = { agentDir, config: emptyConfig() };
	await handleProvidersCommand(h.pi, h.ctx, runtime, "add");
	assert.equal(h.registered.length, 0);

	const stored = harness({ name: "unused", base: "", key: "", filter: "" });
	const seededConfig: HubConfig = {
		version: 1,
		providers: [
			{
				id: "broken-site",
				name: "Broken Site",
				baseUrl,
				apiKey: "wrong-key",
				api: "openai-completions",
				filter: "",
				models: [
					{
						id: "mock-chat-pro",
						name: "mock-chat-pro",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200000,
						maxTokens: 8192,
					},
				],
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
	saveConfig(agentDir, seededConfig);
	const seeded: HubRuntime = { agentDir, config: seededConfig };
	await handleProvidersCommand(stored.pi, stored.ctx, seeded, "test broken-site");
	assert.equal(
		stored.notices.some((notice) => notice.includes("连接失败") && notice.includes("401")),
		true,
		JSON.stringify(stored.notices),
	);
});