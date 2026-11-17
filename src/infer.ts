import type { RawModel } from "./discovery.ts";
import type { StoredModel } from "./store.ts";

const DEFAULT_CONTEXT = 131072;
const DEFAULT_MAX_TOKENS = 8192;
const REASONING_MAX_TOKENS = 16384;

/** Common context sizes keyed by the numeric part of a 64k/128k/200k suffix. */
const SUFFIX_CONTEXT: Record<number, number> = {
	8: 8192,
	16: 16384,
	32: 32768,
	64: 65536,
	128: 131072,
	200: 200000,
	256: 262144,
	512: 524288,
	1000: 1000000,
	1024: 1048576,
};

const FAMILY_CONTEXT: Array<[RegExp, number]> = [
	[/claude/i, 200000],
	[/gemini/i, 1048576],
	[/deepseek/i, 131072],
	[/qwen|qwen2|qwen3/i, 131072],
	[/gpt-4\.1|gpt-5|o3|o4/i, 131072],
];

const VISION_RE = /(^|[-_/])(vision|vl|omni|pixtral|llava|image)([-_/]|$)/i;
const VISION_FAMILY_RE = /claude|gpt-4o|gpt-4\.1|gpt-5|gemini/i;
const REASONING_RE =
	/(^|[-_/])(o1|o3|o4|r1|reasoning|reasoner|thinking|think|qwq)([-_/]|$)/i;
const REASONING_FAMILY_RE = /deepseek-r1|gpt-5(?!-chat)|gemini-2\.5/i;

export function inferContextWindow(id: string): number {
	const suffix = /(?:^|[-_/.])(\d{1,4})(k|m)(?:[-_/.]|$)/i.exec(id);
	if (suffix) {
		const amount = Number(suffix[1]);
		const unit = suffix[2]!.toLowerCase();
		if (unit === "m") return amount * 1_000_000;
		const known = SUFFIX_CONTEXT[amount];
		if (known) return known;
		if (amount >= 8) return amount * 1000;
	}
	for (const [pattern, size] of FAMILY_CONTEXT) {
		if (pattern.test(id)) return size;
	}
	return DEFAULT_CONTEXT;
}

export function inferVision(id: string): boolean {
	return VISION_RE.test(id) || VISION_FAMILY_RE.test(id);
}

export function inferReasoning(id: string): boolean {
	return REASONING_RE.test(id) || REASONING_FAMILY_RE.test(id);
}

/** Convert a discovered model into the stored/registered form. */
export function toStoredModel(raw: RawModel): StoredModel {
	const reasoning = raw.reasoning ?? inferReasoning(raw.id);
	const vision = raw.vision ?? inferVision(raw.id);
	return {
		id: raw.id,
		name: raw.name?.trim() || raw.id,
		reasoning,
		input: vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: raw.contextWindow ?? inferContextWindow(raw.id),
		maxTokens: raw.maxTokens ?? (reasoning ? REASONING_MAX_TOKENS : DEFAULT_MAX_TOKENS),
	};
}