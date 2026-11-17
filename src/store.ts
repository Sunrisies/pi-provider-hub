import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Protocol choices offered in the UI. "auto" is resolved while fetching models. */
export type ApiChoice =
	| "auto"
	| "openai-completions"
	| "anthropic-messages"
	| "openai-responses"
	| "google-generative-ai";

/** Concrete protocol stored on disk (auto is resolved before saving). */
export type ResolvedApi = Exclude<ApiChoice, "auto">;

export interface StoredModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

export interface StoredProvider {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	api: ResolvedApi;
	filter: string;
	models: StoredModel[];
	createdAt: string;
	updatedAt: string;
}

export interface HubConfig {
	version: 1;
	providers: StoredProvider[];
}

export interface LoadResult {
	config: HubConfig;
	error?: string;
}

export const CONFIG_FILENAME = "provider-hub.json";

export function configPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILENAME);
}

export function emptyConfig(): HubConfig {
	return { version: 1, providers: [] };
}

export function slugify(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-._]+/, "")
		.replace(/[-._]+$/, "")
		.slice(0, 64);
}

export function isValidProviderId(id: string): boolean {
	return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id);
}

/**
 * Escape a literal so pi's provider config parser treats it as data.
 * pi interprets `$ENV`, `!command`, `$$` and `$!` in apiKey strings.
 */
export function escapeConfigValue(value: string): string {
	let out = value.replace(/\$/g, () => "$$");
	if (out.startsWith("!")) out = "$!" + out.slice(1);
	return out;
}

export function maskKey(key: string): string {
	if (!key) return "（未设置）";
	if (key.length <= 8) return "****";
	return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function normalizeModel(raw: unknown): StoredModel | undefined {
	if (!isRecord(raw)) return undefined;
	const id = asString(raw.id)?.trim();
	if (!id) return undefined;
	const name = asString(raw.name)?.trim() || id;
	const inputRaw = Array.isArray(raw.input) ? raw.input : ["text"];
	const input: ("text" | "image")[] = inputRaw.includes("image") ? ["text", "image"] : ["text"];
	const costRaw = isRecord(raw.cost) ? raw.cost : {};
	return {
		id,
		name,
		reasoning: asBoolean(raw.reasoning) ?? false,
		input,
		cost: {
			input: asNumber(costRaw.input) ?? 0,
			output: asNumber(costRaw.output) ?? 0,
			cacheRead: asNumber(costRaw.cacheRead) ?? 0,
			cacheWrite: asNumber(costRaw.cacheWrite) ?? 0,
		},
		contextWindow: asNumber(raw.contextWindow) ?? 131072,
		maxTokens: asNumber(raw.maxTokens) ?? 8192,
	};
}

function normalizeProvider(raw: unknown): StoredProvider | undefined {
	if (!isRecord(raw)) return undefined;
	const id = asString(raw.id)?.trim();
	const baseUrl = asString(raw.baseUrl)?.trim();
	const apiKey = asString(raw.apiKey);
	const api = asString(raw.api);
	if (!id || !isValidProviderId(id) || !baseUrl || apiKey === undefined || !api) return undefined;
	if (api !== "openai-completions" && api !== "anthropic-messages" && api !== "openai-responses" && api !== "google-generative-ai") {
		return undefined;
	}
	const models = (Array.isArray(raw.models) ? raw.models : [])
		.map(normalizeModel)
		.filter((model): model is StoredModel => model !== undefined);
	return {
		id,
		name: asString(raw.name)?.trim() || id,
		baseUrl,
		apiKey,
		api,
		filter: asString(raw.filter) ?? "",
		models,
		createdAt: asString(raw.createdAt) ?? new Date().toISOString(),
		updatedAt: asString(raw.updatedAt) ?? new Date().toISOString(),
	};
}

/** Read the hub config. Corrupt files yield an empty config plus an error message. */
export function loadConfig(agentDir: string): LoadResult {
	const path = configPath(agentDir);
	if (!existsSync(path)) return { config: emptyConfig() };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) return { config: emptyConfig(), error: "配置文件格式不正确（根节点不是对象）" };
		const rawProviders = Array.isArray(parsed.providers) ? parsed.providers : [];
		const seen = new Set<string>();
		const providers: StoredProvider[] = [];
		for (const raw of rawProviders) {
			const provider = normalizeProvider(raw);
			if (!provider || seen.has(provider.id)) continue;
			seen.add(provider.id);
			providers.push(provider);
		}
		return { config: { version: 1, providers } };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { config: emptyConfig(), error: `配置文件读取失败：${message}` };
	}
}

/** Atomically write the hub config with owner-only permissions. */
export function saveConfig(agentDir: string, config: HubConfig): void {
	const path = configPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	const body = `${JSON.stringify(config, null, 2)}\n`;
	writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(tmp, 0o600);
	} catch {
		// chmod is best-effort on Windows.
	}
	renameSync(tmp, path);
}

export function findProvider(config: HubConfig, id: string): StoredProvider | undefined {
	return config.providers.find((provider) => provider.id === id);
}

export function timestamp(): string {
	return new Date().toISOString();
}