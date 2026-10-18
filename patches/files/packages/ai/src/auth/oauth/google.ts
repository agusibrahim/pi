/**
 * Google Gemini (Generative Language API) Android AAS auth flow
 *
 * The Gemini Developer API accepts OAuth access tokens only as
 * `Authorization: Bearer <token>`. `@google/genai` turns any `GoogleGenAI`
 * `apiKey` into an `x-goog-api-key` header instead, and the API rejects OAuth
 * tokens there with `API_KEY_INVALID`. So `toAuth` returns the token as a
 * request header rather than as an `apiKey`.
 *
 * Credential source: the Android auth service (AAS). The user pastes a master
 * AAS token (`aas_et/...`, optionally the full
 * `androidId=...&Email=...&Token=...` auth string it belongs to) and the flow
 * exchanges it for a short-lived `ya29...` access token. Because the master token
 * outlives the access token, `refresh` re-runs the same exchange, so one paste
 * keeps working across the ~1 hour access-token lifetime.
 */

import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";

const AAS_TOKEN_URL = "https://android.googleapis.com/auth";
const AAS_USER_AGENT = "GoogleAuth/1.4";
/** Google Play services identity the AAS exchange is performed as. */
const AAS_APP = "com.google.android.googlequicksearchbox";
const AAS_CLIENT_SIG = "38918a453d07199354f8b19af05ec6562ced5788";
const AAS_DEVICE_COUNTRY = "id";
const AAS_GOOGLE_PLAY_SERVICES_VERSION = "263332035";
const AAS_SDK_VERSION = "35";
/**
 * Scopes requested from the exchange. The Gemini API needs
 * `generative-language`; the remaining scopes let the same master token serve
 * the other Google APIs reachable from an Android account. AAS takes the
 * `oauth2:` scheme marker once, on the first scope only.
 */
const AAS_SCOPES = [
	"https://www.googleapis.com/auth/assistant",
	"https://www.googleapis.com/auth/generative-language",
	"https://www.googleapis.com/auth/photos.image.readonly",
	"https://www.googleapis.com/auth/drive",
];
const AAS_SERVICE = `oauth2:${AAS_SCOPES.join(" ")}`;
/** AAS reports a 1 hour lifetime; assume a shorter one when it does not say. */
const ASSUMED_ACCESS_TOKEN_LIFETIME_MS = 55 * 60 * 1000;

interface AasMaster {
	androidId?: string;
	Email?: string;
	token: string;
}

function readString(value: string | undefined): string | undefined {
	const trimmed = value
		?.trim()
		.replace(/^'+|'+$/g, "")
		.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Accept either a bare master token or the `androidId`/`Email`/`Token` query
 * string Google and Android tooling store alongside it.
 */
function parseAasMaster(input: string): AasMaster {
	const trimmed = input
		.trim()
		.replace(/^"+|"+$/g, "")
		.trim();
	const unescaped = (() => {
		try {
			return decodeURIComponent(trimmed);
		} catch {
			return trimmed;
		}
	})();

	if (unescaped.startsWith("aas_et/")) return { token: unescaped };

	const query = new URLSearchParams(unescaped);
	const token = readString(query.get("Token") ?? undefined) ?? readString(query.get("token") ?? undefined);
	if (token) {
		return {
			token,
			androidId: readString(query.get("androidId") ?? undefined),
			Email: readString(query.get("Email") ?? undefined),
		};
	}

	const marker = trimmed.indexOf("aas_et");
	if (marker >= 0) return { token: unescaped.slice(marker) };

	throw new Error("No AAS master token found. Paste aas_et/... or androidId=...&Email=...&Token=...");
}

/**
 * AAS answers with a `key=value` block separated by spaces, commas and
 * semicolons, with quoted values and space-containing lists such as
 * `grantedScopes`. Unkeyed tokens continue the previous value.
 */
function parseAasResponse(body: string): Map<string, string> {
	const fields = new Map<string, string>();
	let lastKey: string | undefined;
	for (const chunk of body.split(/[\s,;]+/)) {
		const token = chunk.replace(/^'+|'+$/g, "");
		if (!token) continue;
		const separator = token.indexOf("=");
		if (separator > 0) {
			const key = token.slice(0, separator);
			const value = token.slice(separator + 1);
			fields.set(key, fields.has(key) ? `${fields.get(key)},${value}` : value);
			lastKey = key;
		} else if (lastKey) {
			fields.set(lastKey, `${fields.get(lastKey)} ${token}`);
		}
	}
	return fields;
}

function readExpires(fields: Map<string, string>): number {
	const expiry = Number(fields.get("Expiry"));
	if (Number.isFinite(expiry) && expiry > 0) return expiry * 1000;
	const duration = Number(fields.get("ExpiresInDurationSec"));
	if (Number.isFinite(duration) && duration > 0) return Date.now() + duration * 1000;
	return Date.now() + ASSUMED_ACCESS_TOKEN_LIFETIME_MS;
}

async function exchangeAasMaster(master: AasMaster, signal: AbortSignal): Promise<OAuthCredential> {
	const body = new URLSearchParams({
		Token: master.token,
		Email: master.Email ?? "",
		service: AAS_SERVICE,
		app: AAS_APP,
		callerPkg: AAS_APP,
		client_sig: AAS_CLIENT_SIG,
		callerSig: AAS_CLIENT_SIG,
		source: "android",
		device_country: AAS_DEVICE_COUNTRY,
		lang: "en_US",
		sdk_version: AAS_SDK_VERSION,
		google_play_services_version: AAS_GOOGLE_PLAY_SERVICES_VERSION,
		...(master.androidId ? { androidId: master.androidId } : {}),
	});

	let response: Response;
	try {
		response = await fetch(AAS_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": AAS_USER_AGENT,
			},
			body,
			signal,
		});
	} catch (error) {
		throw new Error(
			`Google AAS token exchange request failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const text = await response.text().catch(() => "");
	if (!response.ok) {
		throw new Error(`Google AAS token exchange failed (${response.status}): ${text.slice(0, 400)}`);
	}

	const fields = parseAasResponse(text);
	const failure = readString(fields.get("Error"));
	if (failure) throw new Error(`Google AAS token exchange rejected the master token: ${failure}`);

	const access = readString(fields.get("Auth"));
	if (!access) {
		throw new Error(`Google AAS token exchange returned no Auth value: ${text.slice(0, 400)}`);
	}

	return {
		type: "oauth",
		access,
		// The AAS master token is what renews the access token, so it occupies the
		// canonical `refresh` slot.
		refresh: master.token,
		expires: readExpires(fields),
		aas_android_id: master.androidId ?? "",
		aas_email: master.Email ?? "",
	};
}

function masterFromCredential(credential: OAuthCredential): AasMaster {
	const token = readString(credential.refresh);
	if (!token) {
		throw new Error("Google AAS credential cannot renew itself. Log in again to enter a new AAS token.");
	}
	return {
		token,
		androidId: readString(typeof credential.aas_android_id === "string" ? credential.aas_android_id : undefined),
		Email: readString(typeof credential.aas_email === "string" ? credential.aas_email : undefined),
	};
}

export const googleOAuth: OAuthAuth = {
	name: "Google Gemini (Android AAS)",
	loginLabel: "Sign in with a Google Android AAS token",

	async login(interaction: ProviderAuthInteraction) {
		const input = await interaction.prompt({
			type: "secret",
			message: "Paste Google AAS token (aas_et/... or androidId=...&Email=...&Token=...)",
			placeholder: "aas_et/...",
		});
		const master = parseAasMaster(input);
		let email = master.Email;
		if (!email) {
			// AAS cross-checks the account, so a bare master token is not enough.
			email = readString(
				await interaction.prompt({ type: "text", message: "Google account email for the AAS token" }),
			);
			if (!email) throw new Error("Missing Google account email for the AAS token");
		}
		return exchangeAasMaster({ ...master, Email: email }, interaction.signal);
	},

	async refresh(credential, signal) {
		return exchangeAasMaster(masterFromCredential(credential), signal);
	},

	// No apiKey: the SDK would turn one into `x-goog-api-key`, which the Gemini
	// API rejects for OAuth tokens.
	async toAuth(credential) {
		return { headers: { Authorization: `Bearer ${credential.access}` } };
	},
};
