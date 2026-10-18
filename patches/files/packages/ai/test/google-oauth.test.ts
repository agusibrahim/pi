import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googleOAuth } from "../src/auth/oauth/google.ts";
import type { AuthPrompt, ProviderAuthInteraction } from "../src/auth/types.ts";
import { googleProvider } from "../src/providers/google.ts";

const AAS_TOKEN_URL = "https://android.googleapis.com/auth";
const MASTER_TOKEN = "aas_et/AKppINtestmastertokenvalue";
const ACCESS_TOKEN = "ya29.test-access-token";

function aasResponse(fields: Record<string, string>): Response {
	return new Response(
		`SID=${crypto.randomUUID()}\n${Object.entries(fields)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n")}\n`,
		{ status: 200 },
	);
}

function getUrl(input: unknown): string {
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	if (typeof input === "string") return input;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function createInteraction(answers: Record<string, string>): ProviderAuthInteraction {
	return {
		signal: new AbortController().signal,
		prompt: async (prompt: AuthPrompt) => {
			const answer = answers[prompt.message];
			if (answer !== undefined) return answer;
			if (prompt.type === "select") return prompt.options[0]!.id;
			throw new Error(`Unexpected prompt: ${prompt.message}`);
		},
		notify: () => {},
	};
}

const AAS_PROMPT = "Paste Google AAS token (aas_et/... or androidId=...&Email=...&Token=...)";

describe("Google Android AAS OAuth", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-18T00:00:00Z"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("registers OAuth alongside the api key on the google provider", () => {
		const provider = googleProvider();
		expect(provider.auth.oauth).toBeDefined();
		expect(provider.auth.apiKey).toBeDefined();
	});

	it("derives a bearer header instead of an api key", async () => {
		await expect(
			googleOAuth.toAuth({ type: "oauth", access: ACCESS_TOKEN, refresh: MASTER_TOKEN, expires: 1 }),
		).resolves.toEqual({ headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
	});

	it("exchanges a bare AAS master token for an access token", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit) => {
				expect(getUrl(input)).toBe(AAS_TOKEN_URL);
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ "User-Agent": "GoogleAuth/1.4" });
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("Token")).toBe(MASTER_TOKEN);
				expect(body.get("Email")).toBe("cafe@agusibrah.im");
				expect(body.get("app")).toBe("com.google.android.googlequicksearchbox");
				expect(body.get("callerSig")).toBe("38918a453d07199354f8b19af05ec6562ced5788");
				expect(body.get("service")).toBe(
					"oauth2:https://www.googleapis.com/auth/assistant https://www.googleapis.com/auth/generative-language https://www.googleapis.com/auth/photos.image.readonly https://www.googleapis.com/auth/drive",
				);
				expect(body.get("source")).toBe("android");
				return aasResponse({ Auth: ACCESS_TOKEN, ExpiresInDurationSec: "3600" });
			}),
		);

		await expect(
			googleOAuth.login(
				createInteraction({
					[AAS_PROMPT]: MASTER_TOKEN,
					"Google account email for the AAS token": "cafe@agusibrah.im",
				}),
			),
		).resolves.toEqual({
			type: "oauth",
			access: ACCESS_TOKEN,
			refresh: MASTER_TOKEN,
			expires: Date.now() + 3600 * 1000,
			aas_android_id: "",
			aas_email: "cafe@agusibrah.im",
		});
	});

	it("accepts the full AAS auth string and skips the email prompt", async () => {
		const androidId = "3c4096cfd46caf54";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("Token")).toBe(MASTER_TOKEN);
				expect(body.get("Email")).toBe("cafe@agusibrah.im");
				expect(body.get("androidId")).toBe(androidId);
				return aasResponse({ Auth: ACCESS_TOKEN, Expiry: `${(Date.now() + 3600 * 1000) / 1000}` });
			}),
		);

		const credential = await googleOAuth.login(
			createInteraction({
				[AAS_PROMPT]: `androidId=${androidId}&Email=cafe%40agusibrah.im&Token=${MASTER_TOKEN}`,
			}),
		);

		expect(credential).toMatchObject({
			access: ACCESS_TOKEN,
			refresh: MASTER_TOKEN,
			expires: Date.now() + 3600 * 1000,
			aas_android_id: androidId,
			aas_email: "cafe@agusibrah.im",
		});
	});

	it("prefers the absolute Expiry over the relative duration", async () => {
		const expirySeconds = Math.floor(Date.now() / 1000) + 1234;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				aasResponse({ Auth: ACCESS_TOKEN, ExpiresInDurationSec: "9999", Expiry: `${expirySeconds}` }),
			),
		);

		const credential = await googleOAuth.login(
			createInteraction({
				[AAS_PROMPT]: MASTER_TOKEN,
				"Google account email for the AAS token": "cafe@agusibrah.im",
			}),
		);

		expect(credential.expires).toBe(expirySeconds * 1000);
	});

	it("re-exchanges the stored master token when the access token expires", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("Token")).toBe(MASTER_TOKEN);
				expect(body.get("Email")).toBe("cafe@agusibrah.im");
				expect(body.get("androidId")).toBe("3c4096cfd46caf54");
				return aasResponse({ Auth: "ya29.renewed", ExpiresInDurationSec: "3600" });
			}),
		);

		await expect(
			googleOAuth.refresh(
				{
					type: "oauth",
					access: ACCESS_TOKEN,
					refresh: MASTER_TOKEN,
					expires: 1,
					aas_android_id: "3c4096cfd46caf54",
					aas_email: "cafe@agusibrah.im",
				},
				new AbortController().signal,
			),
		).resolves.toEqual({
			type: "oauth",
			access: "ya29.renewed",
			refresh: MASTER_TOKEN,
			expires: Date.now() + 3600 * 1000,
			aas_android_id: "3c4096cfd46caf54",
			aas_email: "cafe@agusibrah.im",
		});
	});

	it("surfaces the AAS error field instead of a generic failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Error=BadAuthentication\nurl='https://android.clients.google.com/auth'")),
		);

		await expect(
			googleOAuth.login(
				createInteraction({
					[AAS_PROMPT]: MASTER_TOKEN,
					"Google account email for the AAS token": "cafe@agusibrah.im",
				}),
			),
		).rejects.toThrow("Google AAS token exchange rejected the master token: BadAuthentication");
	});

	it("surfaces AAS HTTP failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("upstream boom", { status: 503 })),
		);

		await expect(
			googleOAuth.login(
				createInteraction({
					[AAS_PROMPT]: MASTER_TOKEN,
					"Google account email for the AAS token": "cafe@agusibrah.im",
				}),
			),
		).rejects.toThrow("Google AAS token exchange failed (503): upstream boom");
	});

	it("refuses input without a master token", async () => {
		await expect(googleOAuth.login(createInteraction({ [AAS_PROMPT]: "not-a-token" }))).rejects.toThrow(
			"No AAS master token found",
		);
	});

	it("refuses to renew a credential with no master token", async () => {
		await expect(
			googleOAuth.refresh(
				{ type: "oauth", access: ACCESS_TOKEN, refresh: "", expires: 1 },
				new AbortController().signal,
			),
		).rejects.toThrow("Google AAS credential cannot renew itself. Log in again to enter a new AAS token.");
	});

	it("assumes a short lifetime when AAS reports no expiry", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => aasResponse({ Auth: ACCESS_TOKEN })),
		);

		const credential = await googleOAuth.login(
			createInteraction({
				[AAS_PROMPT]: MASTER_TOKEN,
				"Google account email for the AAS token": "cafe@agusibrah.im",
			}),
		);

		expect(credential.expires).toBe(Date.now() + 55 * 60 * 1000);
	});
});
