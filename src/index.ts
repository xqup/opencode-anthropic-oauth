import type { Plugin } from "@opencode-ai/plugin"
import {
  createAuthorizationRequest,
  exchangeCodeForTokens,
  refreshTokens,
  USER_AGENT,
  BETA_FLAGS,
} from "./oauth.js"

const REFRESH_INTERVAL = 5 * 60 * 1000 // check every 5 minutes
const REFRESH_BUFFER = 10 * 60 * 1000 // refresh 10 min before expiry
const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

const plugin: Plugin = async ({ client }) => {
  // Shared ref to getAuth — set when loader runs, used by background timer
  let _getAuth: (() => Promise<any>) | null = null

  async function proactiveRefresh() {
    if (!_getAuth) return
    try {
      const auth = await _getAuth()
      if (!auth || auth.type !== "oauth" || !auth.refresh) return
      if (auth.expires > Date.now() + REFRESH_BUFFER) return

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
    } catch {
      // Non-fatal — will retry next interval
    }
  }

  // Start background refresh timer
  setInterval(() => proactiveRefresh(), REFRESH_INTERVAL)

  return {
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if ((auth as any).type !== "oauth") return {}

        // Share getAuth with background timer
        _getAuth = getAuth

        // Kick off first proactive refresh
        proactiveRefresh()

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

            // Fallback: refresh inline if token somehow expired between timer runs
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

            // Merge beta flags
            const incoming = (headers.get("anthropic-beta") || "")
              .split(",")
              .map((b) => b.trim())
              .filter(Boolean)
            const required = BETA_FLAGS.split(",").map((b) => b.trim())
            const merged = [...new Set([...required, ...incoming])].join(",")

            headers.set("authorization", `Bearer ${access}`)
            headers.set("anthropic-beta", merged)
            headers.set("anthropic-dangerous-direct-browser-access", "true")
            headers.set("user-agent", USER_AGENT)
            headers.set("x-app", "cli")
            headers.delete("x-api-key")

            // Add ?beta=true to messages endpoint (required for OAuth)
            let url =
              input instanceof Request ? input.url : input.toString()
            if (url.includes("/v1/messages") && !url.includes("beta=true")) {
              const sep = url.includes("?") ? "&" : "?"
              url = `${url}${sep}beta=true`
            }

            // Transform body for OAuth compatibility
            let body = init?.body
            if (typeof body === "string" && url.includes("/v1/messages")) {
              try {
                const parsed = JSON.parse(body)

                // Inject system identity prefix (required by claude-code beta)
                if (Array.isArray(parsed.system)) {
                  const hasIdentity = parsed.system.some(
                    (s: any) =>
                      typeof s === "string"
                        ? s.includes(SYSTEM_IDENTITY)
                        : s?.text?.includes(SYSTEM_IDENTITY),
                  )
                  if (!hasIdentity) {
                    parsed.system.unshift({ type: "text", text: SYSTEM_IDENTITY })
                  }
                } else if (!parsed.system) {
                  parsed.system = [{ type: "text", text: SYSTEM_IDENTITY }]
                }

                // Strip cache_control (OAuth rejects it since 2026-03-17)
                const strip = (obj: any): any => {
                  if (Array.isArray(obj)) return obj.map(strip)
                  if (obj && typeof obj === "object") {
                    const { cache_control, ...rest } = obj
                    return Object.fromEntries(
                      Object.entries(rest).map(([k, v]) => [k, strip(v)]),
                    )
                  }
                  return obj
                }

                body = JSON.stringify(strip(parsed))
              } catch {
                // leave body as-is
              }
            }

            return fetch(url, {
              method: init?.method ?? "POST",
              headers,
              body,
              signal: init?.signal,
            })
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
