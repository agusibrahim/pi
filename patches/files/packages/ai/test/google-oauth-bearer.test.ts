import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				yield {
					responseId: "gemini-response-id",
					candidates: [
						{
							content: { parts: [{ text: "ok" }] },
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 1,
						candidatesTokenCount: 1,
						totalTokenCount: 2,
					},
				};
			},
		};

		constructor(config: Record<string, unknown>) {
			googleGenAiMock.constructorCalls.push(config);
		}
	}

	return {
		GoogleGenAI,
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

const model = getModel("google", "gemini-3-flash-preview");
const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

function lastClient(): Record<string, unknown> {
	const calls = googleGenAiMock.constructorCalls;
	if (calls.length !== 1) throw new Error(`Expected exactly one GoogleGenAI call, got ${calls.length}`);
	return calls[0] as Record<string, unknown>;
}

function clientHeaders(): Record<string, string> {
	return (lastClient().httpOptions as { headers: Record<string, string> }).headers;
}

/**
 * The Gemini Developer API accepts OAuth access tokens only as
 * `Authorization: Bearer`. `@google/genai` derives `x-goog-api-key` from any
 * `apiKey` and the API answers `API_KEY_INVALID` for an OAuth token there, so
 * the bearer path must suppress the apiKey entirely.
 */
describe("google bearer auth", () => {
	beforeEach(() => {
		googleGenAiMock.constructorCalls.length = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("sends an OAuth token as a bearer header and no api key", async () => {
		const stream = streamGoogle(model, context, {
			headers: { Authorization: "Bearer ya29.test-access-token" },
		});

		await stream.result();

		expect(clientHeaders()).toMatchObject({ Authorization: "Bearer ya29.test-access-token" });
		// The SDK treats an undefined apiKey as "use Application Default
		// Credentials" and then fails with "Could not load the default
		// credentials", so it gets a placeholder instead. Pre-setting
		// x-goog-api-key keeps the SDK from sending that placeholder.
		expect(lastClient().apiKey).toBeTruthy();
		expect(clientHeaders()["x-goog-api-key"]).toBe("");
	});

	it("prefers the bearer header over an api key that would become x-goog-api-key", async () => {
		const stream = streamGoogle(model, context, {
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
			headers: { authorization: "Bearer ya29.test-access-token" },
		});

		await stream.result();

		expect(lastClient().apiKey).not.toBe("AIzaSyExampleRealisticLookingApiKey123456");
		expect(clientHeaders().authorization).toBe("Bearer ya29.test-access-token");
	});

	it("does not overwrite a caller-supplied x-goog-api-key", async () => {
		const stream = streamGoogle(model, context, {
			headers: {
				Authorization: "Bearer ya29.test-access-token",
				"X-Goog-Api-Key": "caller-value",
			},
		});

		await stream.result();

		const apiKeyHeader = Object.entries(clientHeaders()).find(([name]) => name.toLowerCase() === "x-goog-api-key");
		expect(apiKeyHeader?.[1]).toBe("caller-value");
	});

	it("still passes through api keys unchanged", async () => {
		const stream = streamGoogle(model, context, {
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
		});

		await stream.result();

		expect(lastClient().apiKey).toBe("AIzaSyExampleRealisticLookingApiKey123456");
		expect(clientHeaders()).not.toHaveProperty("Authorization");
		expect(clientHeaders()).not.toHaveProperty("authorization");
	});

	it("fails with a clear message when no credential is available", async () => {
		const stream = streamGoogle(model, context, {});

		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("No API key or OAuth token for provider: google");
		expect(googleGenAiMock.constructorCalls).toHaveLength(0);
	});
});
