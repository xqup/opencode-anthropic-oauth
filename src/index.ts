import type { Plugin } from "@opencode-ai/plugin"
import {
  createAuthorizationRequest,
  exchangeCodeForTokens,
  refreshTokens,
  USER_AGENT,
  BETA_FLAGS,
} from "./oauth.js"

const plugin: Plugin = async ({ client }) => {
  return {
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if ((auth as any).type !== "oauth") return {}

        // Zero out cost for Pro/Max subscription
        for (const model of Object.values(provider.models)) {
          ;(model as any).cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          }
        }

        return {
          apiKey: "",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const auth = (await getAuth()) as any
            if (auth.type !== "oauth") return fetch(input, init)

            let access = auth.access as string

            // Auto-refresh if expired
            if (!access || auth.expires < Date.now()) {
              try {
                const fresh = await refreshTokens(auth.refresh)
                await client.auth.set({
                  path: { id: "anthropic" },
                  body: {
                    type: "oauth",
                    refresh: fresh.refresh,
                    access: fresh.access,
                    expires: fresh.expires,
                  },
                })
                access = fresh.access
              } catch (err) {
                throw new Error(
                  `Token refresh failed: ${err instanceof Error ? err.message : err}`,
                )
              }
            }

            // Build headers
            const headers = new Headers()
            if (input instanceof Request) {
              input.headers.forEach((v, k) => headers.set(k, v))
            }
            if (init?.headers) {
              const h = init.headers
              if (h instanceof Headers) {
                h.forEach((v, k) => headers.set(k, v))
              } else if (Array.isArray(h)) {
                for (const [k, v] of h) {
                  if (v !== undefined) headers.set(k, String(v))
                }
              } else {
                for (const [k, v] of Object.entries(h)) {
                  if (v !== undefined) headers.set(k, String(v))
                }
              }
            }

            // Merge beta flags — keep incoming betas + add required ones
            const incoming = (headers.get("anthropic-beta") || "")
              .split(",")
              .map((b) => b.trim())
              .filter(Boolean)
            const required = BETA_FLAGS.split(",").map((b) => b.trim())
            const merged = [...new Set([...required, ...incoming])].join(",")

            headers.set("authorization", `Bearer ${access}`)
            headers.set("anthropic-beta", merged)
            headers.set("user-agent", USER_AGENT)
            headers.set("x-app", "cli")
            headers.delete("x-api-key")

            return fetch(input, { ...init, headers })
          },
        }
      },
      methods: [
        {
          type: "oauth" as const,
          label: "Claude Pro/Max",
          authorize() {
            const { url, verifier } = createAuthorizationRequest()

            return Promise.resolve({
              url,
              instructions:
                "Open the link above to authenticate with your Claude account. " +
                "After authorizing, you'll receive a code — paste it below.",
              method: "code" as const,
              async callback(code: string) {
                try {
                  const tokens = await exchangeCodeForTokens(code, verifier)
                  return {
                    type: "success" as const,
                    access: tokens.access,
                    refresh: tokens.refresh,
                    expires: tokens.expires,
                  }
                } catch (err) {
                  console.error(
                    "opencode-anthropic-oauth: token exchange failed:",
                    err instanceof Error ? err.message : err,
                  )
                  return { type: "failed" as const }
                }
              },
            })
          },
        },
      ],
    },
  }
}

export default plugin
