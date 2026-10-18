# Patches

Patches applied on top of upstream pi. The fork's tracked source is unmodified
upstream, so syncing with `earendil-works/pi` stays a plain merge; everything
here is applied at build time.

## `google-aas.patch`

Adds Android AAS sign-in to the `google` provider.

The Gemini Developer API accepts OAuth access tokens only as
`Authorization: Bearer`. `@google/genai` turns any `GoogleGenAI` `apiKey` into an
`x-goog-api-key` header instead, and the API rejects OAuth tokens there with
`API_KEY_INVALID`. pi only had `apiKey` auth for the `google` provider, so a
valid OAuth token could not be used at all.

The patch:

- adds `packages/ai/src/auth/oauth/google.ts`, which exchanges an Android AAS
  master token (`aas_et/...`) for a short-lived `ya29...` access token, and
  re-exchanges it on refresh so one paste outlives the access token
- registers the loader and the standalone-Bun bundler entry for that flow
- routes auth in `packages/ai/src/api/google-generative-ai.ts` through
  `resolveRequestAuth()`, so a caller-supplied `Authorization` header suppresses
  the SDK's `x-goog-api-key` header

`apply.sh` is idempotent and prefers a plain apply, falling back to a three-way
merge in a scratch `git worktree` so a failed merge never leaves a half-patched
tree. The GitHub Actions workflow applies the patch with the same logic.

## Applying it locally

```sh
./patches/apply.sh            # apply (no-op if already applied)
./patches/apply.sh --check    # report only
./patches/apply.sh --verify   # apply, then run the patch's tests
```

It defaults to the checkout that holds the script; override with `PI_REPO=/path/pi`.

## Caveat

The AAS exchange uses Google's internal Android auth endpoint, not a documented
OAuth flow, so Google can change it without notice. A Gemini API key
(`GEMINI_API_KEY`) or the `google-vertex` provider with Application Default
Credentials remain the supported routes.