import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
	configPath,
	emptyConfig,
	escapeConfigValue,
	findProvider,
	isValidProviderId,
	loadConfig,
	maskKey,
	saveConfig,
	slugify,
	type HubConfig,
} from "../src/store.ts";

const tmpDirs: string[] = [];

function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "provider-hub-test-"));
	tmpDirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test("slugify produces provider ids", () => {
	assert.equal(slugify("My Proxy"), "my-proxy");
	assert.equal(slugify("  sensenova 中转  "), "sensenova");
	assert.equal(slugify("OpenRouter.ai"), "openrouter.ai");
	assert.equal(slugify("a--b__c"), "a--b__c".replace(/--/g, "-"));
	assert.equal(slugify("???"), "");
});

test("isValidProviderId", () => {
	assert.equal(isValidProviderId("openrouter"), true);
	assert.equal(isValidProviderId("my.site_1-2"), true);
	assert.equal(isValidProviderId("-bad"), false);
	assert.equal(isValidProviderId("Bad"), false);
	assert.equal(isValidProviderId(""), false);
	assert.equal(isValidProviderId("a".repeat(65)), false);
});

test("escapeConfigValue escapes pi's $ and ! syntax", () => {
	assert.equal(escapeConfigValue("sk-abc"), "sk-abc");
	assert.equal(escapeConfigValue("sk-$abc"), "sk-$$abc");
	assert.equal(escapeConfigValue("!curl evil"), "$!curl evil");
	assert.equal(escapeConfigValue("a!b"), "a!b");
	assert.equal(escapeConfigValue("$ENV"), "$$ENV");
});

test("maskKey hides most of the key", () => {
	assert.equal(maskKey(""), "（未设置）");
	assert.equal(maskKey("short"), "****");
	assert.equal(maskKey("sk-1234567890abcdef"), "sk-1…cdef");
});

const sampleConfig: HubConfig = {
	version: 1,
	providers: [
		{
			id: "demo",
			name: "Demo",
			baseUrl: "https://api.example.com/v1",
			apiKey: "sk-test-$secret",
			api: "openai-completions",
			filter: "gpt",
			models: [
				{
					id: "gpt-4o-mini",
					name: "GPT-4o mini",
					reasoning: false,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 131072,
					maxTokens: 8192,
				},
			],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
	],
};

test("loadConfig returns an empty config when the file is missing", () => {
	const dir = tempAgentDir();
	const loaded = loadConfig(dir);
	assert.deepEqual(loaded.config, emptyConfig());
	assert.equal(loaded.error, undefined);
	assert.equal(findProvider(loaded.config, "demo"), undefined);
});

test("saveConfig/loadConfig round-trips and writes 0600 mode", () => {
	const dir = tempAgentDir();
	saveConfig(dir, sampleConfig);
	const loaded = loadConfig(dir);
	assert.equal(loaded.error, undefined);
	assert.deepEqual(loaded.config, sampleConfig);
	const raw = JSON.parse(readFileSync(configPath(dir), "utf8"));
	assert.equal(raw.providers[0].apiKey, "sk-test-$secret");
});

test("loadConfig reports corrupt json and returns empty config", () => {
	const dir = tempAgentDir();
	writeFileSync(configPath(dir), "{ nope", "utf8");
	const loaded = loadConfig(dir);
	assert.ok(loaded.error?.includes("配置文件读取失败"));
	assert.deepEqual(loaded.config, emptyConfig());
});

test("loadConfig normalizes invalid providers and duplicate ids", () => {
	const dir = tempAgentDir();
	const body = {
		version: 1,
		providers: [
			sampleConfig.providers[0],
			sampleConfig.providers[0],
			{ id: "Bad Id", baseUrl: "x", apiKey: "k", api: "openai-completions" },
			{ id: "nokey", baseUrl: "https://x/v1", api: "openai-completions" },
			{ id: "badapi", baseUrl: "https://x/v1", apiKey: "k", api: "nope" },
		],
	};
	writeFileSync(configPath(dir), JSON.stringify(body), "utf8");
	const loaded = loadConfig(dir);
	assert.equal(loaded.config.providers.length, 1);
	assert.equal(loaded.config.providers[0]!.id, "demo");
});

test("loadConfig merges absent fields with defaults", () => {
	const dir = tempAgentDir();
	writeFileSync(
		configPath(dir),
		JSON.stringify({
			providers: [
				{
					id: "min",
					baseUrl: "https://x/v1",
					apiKey: "k",
					api: "openai-responses",
					models: [{ id: "m1" }],
				},
			],
		}),
		"utf8",
	);
	const provider = loadConfig(dir).config.providers[0]!;
	assert.equal(provider.name, "min");
	assert.equal(provider.filter, "");
	assert.equal(provider.models[0]!.name, "m1");
	assert.deepEqual(provider.models[0]!.input, ["text"]);
	assert.equal(provider.models[0]!.contextWindow, 131072);
});

test("saveConfig failure keeps the previous file intact", () => {
	const dir = tempAgentDir();
	saveConfig(dir, sampleConfig);
	const before = readFileSync(configPath(dir), "utf8");
	// Force the temp write to fail: the .tmp sibling is a directory.
	mkdirSync(`${configPath(dir)}.tmp`);
	assert.throws(() => saveConfig(dir, emptyConfig()));
	assert.equal(readFileSync(configPath(dir), "utf8"), before);
});