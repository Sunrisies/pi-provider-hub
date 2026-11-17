import type { ApiChoice, ResolvedApi } from "./store.ts";

export const DEFAULT_TIMEOUT_MS = 15000;

export type AuthMode = "bearer" | "x-api-key" | "google";

export interface RawModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	vision?: boolean;
	reasoning?: boolean;
}

export interface FetchAttempt {
	url: string;
	auth: AuthMode;
	status?: number;
	error?: string;
}

export interface FetchResult {
	models: RawModel[];
	/** Number of entries dropped because they are not chat models. */
	skipped: number;
	/** Endpoint that returned the models. */
	url: string;
	auth: AuthMode;
	api: ResolvedApi;
	attempts: FetchAttempt[];
}

export interface FetchOptions {
	baseUrl: string;
	apiKey: string;
	api?: ApiChoice;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

export class DiscoveryError extends Error {
	readonly attempts: FetchAttempt[];

	constructor(message: string, attempts: FetchAttempt[]) {
		super(message);
		this.name = "DiscoveryError";
		this.attempts = attempts;
	}
}

/**
 * Normalize a user-entered base URL: add https, drop a trailing slash, and strip
 * endpoint suffixes such as /chat/completions or /models.
 */
export function normalizeBaseUrl(input: string): string {
	let value = input.trim();
	if (!value) return "";
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
	value = value.replace(/\/+$/, "");
	value = value.replace(/\/chat\/completions$/i, "");
	value = value.replace(/\/responses$/i, "");
	value = value.replace(/\/completions$/i, "");
	value = value.replace(/\/models$/i, "");
	return value.replace(/\/+$/, "");
}

function isHostOnly(baseUrl: string): boolean {
	return /^https?:\/\/[^/]+\/?$/i.test(baseUrl);
}

function hasVersionSuffix(baseUrl: string): boolean {
	return /\/v\d+(?:beta\d*|alpha\d*)?$/i.test(baseUrl);
}

/**
 * Chat base URL implied by the models endpoint that actually answered:
 * https://x/v1/models -> https://x/v1, https://x/models -> https://x.
 */
export function chatBaseFromModelsUrl(modelsUrl: string): string {
	try {
		const parsed = new URL(modelsUrl);
		parsed.search = "";
		parsed.hash = "";
		parsed.pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/models$/, "");
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return modelsUrl.replace(/\/+$/, "").replace(/\/models$/, "");
	}
}

/**
 * Keep the user's base URL when it already carries a path, but promote a bare
 * host to the versioned base that discovery proved to work (e.g. /v1), so chat
 * requests hit the same endpoints as the model list.
 */
export function providerBaseUrl(currentBase: string, modelsUrl: string): string {
	if (isHostOnly(currentBase)) return chatBaseFromModelsUrl(modelsUrl);
	return currentBase;
}

/** Candidate model-list endpoints, most likely first. */
export function candidateModelUrls(baseUrl: string, api?: ApiChoice): string[] {
	const base = baseUrl.replace(/\/+$/, "");
	const urls: string[] = [];
	const add = (url: string) => {
		if (!urls.includes(url)) urls.push(url);
	};
	if (api === "google-generative-ai") {
		add(`${base}/models`);
		if (!hasVersionSuffix(base)) add(`${base}/v1beta/models`);
		return urls;
	}
	if (isHostOnly(base)) {
		add(`${base}/v1/models`);
		add(`${base}/models`);
		return urls;
	}
	add(`${base}/models`);
	if (!hasVersionSuffix(base)) add(`${base}/v1/models`);
	return urls;
}

function authModesFor(api?: ApiChoice): AuthMode[] {
	if (api === "anthropic-messages") return ["x-api-key"];
	if (api === "google-generative-ai") return ["google"];
	if (api === "openai-completions" || api === "openai-responses") return ["bearer"];
	return ["bearer", "x-api-key"];
}

const NON_CHAT_RE =
	/(^|[-_/.])(text-embedding|embedding|embeddings|embed|bge|m3e|whisper|tts|speech|audio|realtime|rerank|reranker|moderation|dall-e|dalle|stable-diffusion|sdxl|flux|clip|gpt-image)([-_/.]|$)/i;

/** Embedding / speech / image-generation models cannot be used as chat models. */
export function isNonChatModel(id: string): boolean {
	return NON_CHAT_RE.test(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function pickNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}

function extractArray(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (!isRecord(payload)) return [];
	for (const key of ["data", "models", "result"]) {
		const value = payload[key];
		if (Array.isArray(value)) return value;
		if (isRecord(value)) {
			for (const innerKey of ["data", "models"]) {
				const inner = value[innerKey];
				if (Array.isArray(inner)) return inner;
			}
		}
	}
	return [];
}

function stripModelsPrefix(id: string): string {
	return id.replace(/^models\//, "");
}

/** Normalize one entry from a /models response. */
function parseEntry(entry: unknown): RawModel | undefined {
	if (typeof entry === "string") {
		const id = entry.trim();
		return id ? { id } : undefined;
	}
	if (!isRecord(entry)) return undefined;

	const methods = entry.supportedGenerationMethods;
	if (Array.isArray(methods) && methods.length > 0 && !methods.includes("generateContent")) {
		return undefined;
	}

	const rawId = pickString(entry.id, entry.model, entry.name);
	if (!rawId) return undefined;
	const id = stripModelsPrefix(rawId);
	if (!id || isNonChatModel(id)) return undefined;

	const displayName = pickString(entry.display_name, entry.displayName);
	const rawEntryName = pickString(entry.name);
	const entryName = rawEntryName ? stripModelsPrefix(rawEntryName) : undefined;
	const name = displayName ?? (entryName && entryName !== id ? entryName : undefined);
	const architecture = isRecord(entry.architecture) ? entry.architecture : undefined;
	const modalities = Array.isArray(architecture?.input_modalities)
		? architecture.input_modalities
		: Array.isArray(entry.input_modalities)
			? entry.input_modalities
			: [];
	const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
	const topProvider = isRecord(entry.top_provider) ? entry.top_provider : undefined;
	const supportedParameters = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];

	const vision =
		entry.supports_vision === true ||
		capabilities?.vision === true ||
		modalities.includes("image") ||
		(Array.isArray(entry.input) && entry.input.includes("image"));

	const reasoning =
		entry.reasoning === true ||
		entry.reasoning_effort === true ||
		capabilities?.reasoning === true ||
		supportedParameters.includes("reasoning") ||
		supportedParameters.includes("reasoning_effort");

	return {
		id,
		name,
		contextWindow: pickNumber(
			entry.context_window,
			entry.context_length,
			entry.max_context_length,
			entry.inputTokenLimit,
			entry.max_input_tokens,
			topProvider?.context_length,
		),
		maxTokens: pickNumber(
			entry.max_output_tokens,
			entry.max_tokens,
			entry.outputTokenLimit,
			entry.max_completion_tokens,
			topProvider?.max_completion_tokens,
		),
		vision,
		reasoning,
	};
}

/** Parse any supported /models response shape, dropping non-chat entries. */
export function parseModelList(payload: unknown): { models: RawModel[]; skipped: number } {
	const entries = extractArray(payload);
	const byId = new Map<string, RawModel>();
	let skipped = 0;
	for (const entry of entries) {
		const model = parseEntry(entry);
		if (!model) {
			skipped++;
			continue;
		}
		const existing = byId.get(model.id);
		if (!existing) {
			byId.set(model.id, model);
			continue;
		}
		// Merge duplicate ids, preferring the first non-empty metadata.
		existing.name = existing.name ?? model.name;
		existing.contextWindow = existing.contextWindow ?? model.contextWindow;
		existing.maxTokens = existing.maxTokens ?? model.maxTokens;
		existing.vision = existing.vision ?? model.vision;
		existing.reasoning = existing.reasoning ?? model.reasoning;
	}
	const models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
	return { models, skipped };
}

/**
 * Filter model ids by keywords. Spaces/commas separate terms; a leading `-`
 * excludes a term. An empty expression keeps everything.
 */
export function filterModels(models: RawModel[], expression: string): RawModel[] {
	const terms = expression
		.split(/[\s,，、]+/)
		.map((term) => term.trim())
		.filter(Boolean);
	if (terms.length === 0) return models;
	const positives = terms.filter((term) => !term.startsWith("-") || term.length === 1).map((term) => term.toLowerCase());
	const negatives = terms.filter((term) => term.startsWith("-") && term.length > 1).map((term) => term.slice(1).toLowerCase());
	return models.filter((model) => {
		const haystack = `${model.id} ${model.name ?? ""}`.toLowerCase();
		if (positives.length > 0 && !positives.some((term) => haystack.includes(term))) return false;
		if (negatives.some((term) => haystack.includes(term))) return false;
		return true;
	});
}

function appendQuery(url: string, query: string): string {
	return url.includes("?") ? `${url}&${query}` : `${url}?${query}`;
}

function authHeaders(auth: AuthMode, apiKey: string): Record<string, string> {
	if (auth === "bearer") return { authorization: `Bearer ${apiKey}` };
	if (auth === "x-api-key") return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
	return { "x-goog-api-key": apiKey };
}

async function describeFailure(response: Response): Promise<string> {
	let detail = "";
	try {
		const text = (await response.text()).slice(0, 300);
		try {
			const parsed: unknown = JSON.parse(text);
			if (isRecord(parsed)) {
				const message = isRecord(parsed.error) ? parsed.error.message : parsed.message;
				detail = typeof message === "string" ? message : text;
			} else {
				detail = text;
			}
		} catch {
			detail = text;
		}
	} catch {
		// ignore body read failures
	}
	detail = detail.replace(/\s+/g, " ").trim();
	return detail ? `${response.status} ${detail.slice(0, 160)}` : String(response.status);
}

function formatAttempts(attempts: FetchAttempt[]): string {
	return attempts
		.slice(0, 6)
		.map((attempt) => {
			const auth = attempt.auth === "bearer" ? "Bearer" : attempt.auth === "x-api-key" ? "x-api-key" : "x-goog-api-key";
			return `• ${attempt.url}（${auth}）→ ${attempt.status ?? attempt.error ?? "失败"}`;
		})
		.join("\n");
}

function resolveApi(api: ApiChoice | undefined, auth: AuthMode): ResolvedApi {
	if (api && api !== "auto") return api;
	if (auth === "x-api-key") return "anthropic-messages";
	return "openai-completions";
}

/**
 * Fetch the model list from a site, trying candidate endpoints and auth styles.
 * Throws DiscoveryError with per-attempt details when nothing works.
 */
export async function fetchModels(options: FetchOptions): Promise<FetchResult> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const apiKey = options.apiKey.trim();
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const doFetch = options.fetchImpl ?? fetch;
	const urls = candidateModelUrls(baseUrl, options.api);
	const authModes = authModesFor(options.api);
	const attempts: FetchAttempt[] = [];
	let skipped = 0;

	for (const url of urls) {
		for (let index = 0; index < authModes.length; index++) {
			const auth = authModes[index]!;
			const attempt: FetchAttempt = { url, auth };
			attempts.push(attempt);
			const timeout = AbortSignal.timeout(timeoutMs);
			const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
			const requestUrl = auth === "x-api-key" ? appendQuery(url, "limit=1000") : url;
			try {
				const response = await doFetch(requestUrl, {
					method: "GET",
					headers: { accept: "application/json", ...authHeaders(auth, apiKey) },
					signal,
				});
				if (!response.ok) {
					attempt.status = response.status;
					attempt.error = await describeFailure(response);
					const canRetryAuth = (response.status === 401 || response.status === 403) && index < authModes.length - 1;
					if (canRetryAuth) continue;
					break;
				}
				let payload: unknown;
				try {
					payload = await response.json();
				} catch {
					attempt.status = response.status;
					attempt.error = "响应不是合法 JSON";
					break;
				}
				const parsed = parseModelList(payload);
				skipped = Math.max(skipped, parsed.skipped);
				if (parsed.models.length === 0) {
					attempt.status = response.status;
					attempt.error = "接口返回 0 个可用对话模型";
					break;
				}
				return {
					models: parsed.models,
					skipped,
					url: requestUrl,
					auth,
					api: resolveApi(options.api, auth),
					attempts,
				};
			} catch (error) {
				attempt.error = error instanceof Error ? error.message : String(error);
				break;
			}
		}
	}

	const reason =
		attempts.length === 0
			? "无法生成候选端点"
			: `没有从 ${baseUrl} 获取到模型列表。已尝试：\n${formatAttempts(attempts)}`;
	throw new DiscoveryError(reason, attempts);
}