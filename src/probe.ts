import type { ResolvedApi } from "./store.ts";

export const PROBE_TIMEOUT_MS = 20000;
const PROMPT = "ping";

export interface ProbeOptions {
	baseUrl: string;
	apiKey: string;
	api: ResolvedApi;
	model: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

export interface ProbeResult {
	ok: boolean;
	latencyMs: number;
	status?: number;
	reply?: string;
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

interface ProbeRequest {
	url: string;
	headers: Record<string, string>;
	body: unknown;
}

export function buildProbeRequest(options: ProbeOptions): ProbeRequest {
	const common = { "content-type": "application/json", accept: "application/json" };
	if (options.api === "anthropic-messages") {
		return {
			url: joinUrl(options.baseUrl, "messages"),
			headers: {
				...common,
				"x-api-key": options.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: {
				model: options.model,
				max_tokens: 16,
				messages: [{ role: "user", content: PROMPT }],
			},
		};
	}
	if (options.api === "google-generative-ai") {
		return {
			url: joinUrl(options.baseUrl, `models/${encodeURIComponent(options.model)}:generateContent`),
			headers: { ...common, "x-goog-api-key": options.apiKey },
			body: {
				contents: [{ role: "user", parts: [{ text: PROMPT }] }],
				generationConfig: { maxOutputTokens: 16 },
			},
		};
	}
	if (options.api === "openai-responses") {
		return {
			url: joinUrl(options.baseUrl, "responses"),
			headers: { ...common, authorization: `Bearer ${options.apiKey}` },
			body: { model: options.model, input: PROMPT, max_output_tokens: 16 },
		};
	}
	return {
		url: joinUrl(options.baseUrl, "chat/completions"),
		headers: { ...common, authorization: `Bearer ${options.apiKey}` },
		body: {
			model: options.model,
			messages: [{ role: "user", content: PROMPT }],
			max_tokens: 16,
			stream: false,
		},
	};
}

function textFromParts(parts: unknown): string {
	if (!Array.isArray(parts)) return "";
	return parts
		.map((part) => {
			if (typeof part === "string") return part;
			if (!isRecord(part)) return "";
			if (typeof part.text === "string") return part.text;
			if (Array.isArray(part.content)) return textFromParts(part.content) || "";
			if (isRecord(part.content)) return textFromParts([part.content]) || "";
			return "";
		})
		.join("");
}

/** Pull a short reply out of any supported chat response. */
export function parseProbeReply(api: ResolvedApi, payload: unknown): string {
	if (!isRecord(payload)) return "";
	if (api === "anthropic-messages") {
		return textFromParts(payload.content).trim();
	}
	if (api === "google-generative-ai") {
		const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
		const first = isRecord(candidates[0]) ? candidates[0] : undefined;
		const content = first && isRecord(first.content) ? first.content : undefined;
		return textFromParts(content?.parts).trim();
	}
	if (api === "openai-responses") {
		if (typeof payload.output_text === "string") return payload.output_text.trim();
		return textFromParts(payload.output).trim();
	}
	const choices = Array.isArray(payload.choices) ? payload.choices : [];
	const first = isRecord(choices[0]) ? choices[0] : undefined;
	if (!first) return "";
	if (isRecord(first.message)) {
		const content = first.message.content;
		if (typeof content === "string") return content.trim();
		return textFromParts(content).trim();
	}
	if (typeof first.text === "string") return first.text.trim();
	return "";
}

async function describeFailure(response: Response): Promise<string> {
	let detail = "";
	try {
		const text = (await response.text()).slice(0, 400);
		try {
			const parsed: unknown = JSON.parse(text);
			if (isRecord(parsed)) {
				const nested = isRecord(parsed.error) ? parsed.error : undefined;
				const message = nested?.message ?? parsed.message ?? parsed.detail;
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
	return detail ? `HTTP ${response.status}: ${detail.slice(0, 200)}` : `HTTP ${response.status}`;
}

/**
 * Send one tiny chat request to prove that a site + key + model actually work.
 * Never throws: transport failures are reported in the result.
 */
export async function probeModel(options: ProbeOptions): Promise<ProbeResult> {
	const started = Date.now();
	const doFetch = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const request = buildProbeRequest(options);
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const send = (payload: ProbeRequest): Promise<Response> =>
		doFetch(payload.url, {
			method: "POST",
			headers: payload.headers,
			body: JSON.stringify(payload.body),
			signal,
		});
	try {
		let response = await send(request);
		let failure = "";
		if (!response.ok) {
			failure = await describeFailure(response);
			// o1/o3/gpt-5 style endpoints reject max_tokens; retry once with the
			// newer parameter instead of reporting a misleading auth failure.
			if (
				response.status === 400 &&
				options.api === "openai-completions" &&
				/max_completion_tokens/.test(failure)
			) {
				const body = { ...(request.body as Record<string, unknown>) };
				delete body.max_tokens;
				body.max_completion_tokens = 16;
				response = await send({ ...request, body });
				failure = response.ok ? "" : await describeFailure(response);
			}
		}
		const latencyMs = Date.now() - started;
		if (!response.ok) {
			return { ok: false, latencyMs, status: response.status, error: failure };
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return { ok: false, latencyMs, status: response.status, error: "响应不是合法 JSON" };
		}
		const reply = parseProbeReply(options.api, payload);
		return { ok: true, latencyMs, status: response.status, reply: reply || "" };
	} catch (error) {
		const latencyMs = Date.now() - started;
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, latencyMs, error: /abort/i.test(message) ? `请求超时（${timeoutMs}ms）` : message };
	}
}