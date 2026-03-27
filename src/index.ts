import type { Plugin } from "@opencode-ai/plugin"
import {
  createAuthorizationRequest,
  exchangeCodeForTokens,
  refreshTokens,
  USER_AGENT,
  BETA_FLAGS,
} from "./oauth.js"

const TOOL_PREFIX = "mcp_"

function transformBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== "string") return body
  try {
    const parsed = JSON.parse(body) as {
      tools?: Array<{ name?: string } & Record<string, unknown>>
      messages?: Array<{ content?: Array<Record<string, unknown>> }>
    }
    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
      }))
    }
    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((message) => {
        if (!Array.isArray(message.content)) return message
        return {
          ...message,
          content: message.content.map((block) => {
            if (block.type !== "tool_use" || typeof block.name !== "string") return block
            return { ...block, name: `${TOOL_PREFIX}${block.name}` }
          }),
        }
      })
    }
    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

function stripToolPrefix(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')
}

function transformResponseStream(response: Response): Response {
  if (!response.body) return response
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  const stream = new ReadableStream({
    async pull(controller) {
      for (;;) {
        const boundary = buffer.indexOf("\n\n")
        if (boundary !== -1) {
          const completeEvent = buffer.slice(0, boundary + 2)
          buffer = buffer.slice(boundary + 2)
          controller.enqueue(encoder.encode(stripToolPrefix(completeEvent)))
          return
        }
        const { done, value } = await reader.read()
        if (done) {
          if (buffer) {
            controller.enqueue(encoder.encode(stripToolPrefix(buffer)))
            buffer = ""
          }
          controller.close()
          return
        }
        buffer += decoder.decode(value, { stream: true })
      }
    },
  })
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

const REFRESH_INTERVAL = 5 * 60 * 1000 // check every 5 minutes
const REFRESH_BUFFER = 10 * 60 * 1000 // refresh 10 min before expiry
const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."
const DEFAULT_CC_VERSION = "2.1.80"

function getCliVersion(): string {
  return process.env.ANTHROPIC_CLI_VERSION ?? DEFAULT_CC_VERSION
}

function getBillingHeader(modelId: string): string {
  return `cc_version=${getCliVersion()}.${modelId}; cc_entrypoint=cli; cch=00000;`
}

const MAX_RETRY_DELAY_S = 20 // cap retry-after to avoid 400s+ waits

async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = 3,
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(input, init)
    if ((res.status === 429 || res.status === 529) && i < retries - 1) {
      const retryAfter = res.headers.get("retry-after")
      const parsed = retryAfter ? Number.parseInt(retryAfter, 10) : Number.NaN
      const delay = Number.isNaN(parsed)
        ? (i + 1) * 2000
        : Math.min(parsed, MAX_RETRY_DELAY_S) * 1000
      await new Promise((r) => setTimeout(r, delay))
      continue
    }
    return res
  }
  return fetch(input, init)
}

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
              input.headers.forEach((v, k) => { headers.set(k, v) })
            }
            if (init?.headers) {
              const h = init.headers
              if (h instanceof Headers) {
                h.forEach((v, k) => { headers.set(k, v) })
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

            // Extract model ID for billing header
            let modelId = "unknown"
            if (typeof init?.body === "string") {
              try {
                modelId = (JSON.parse(init.body) as { model?: string }).model ?? "unknown"
              } catch {}
            }

            headers.set("authorization", `Bearer ${access}`)
            headers.set("anthropic-beta", merged)
            headers.set("anthropic-dangerous-direct-browser-access", "true")
            headers.set("user-agent", USER_AGENT)
            headers.set("x-app", "cli")
            headers.set("x-anthropic-billing-header", getBillingHeader(modelId))
            headers.delete("x-api-key")

            // Add ?beta=true to messages endpoint (required for OAuth)
            let url =
              input instanceof Request ? input.url : input.toString()
            if (url.includes("/v1/messages") && !url.includes("beta=true")) {
              const sep = url.includes("?") ? "&" : "?"
              url = `${url}${sep}beta=true`
            }

            // Transform body: inject system identity + prefix tool names with mcp_
            let body = init?.body
            if (typeof body === "string" && url.includes("/v1/messages")) {
              try {
                const parsed = JSON.parse(body)

                // Inject system identity prefix (required by claude-code beta)
                if (typeof parsed.system === "string") {
                  if (!parsed.system.includes(SYSTEM_IDENTITY)) {
                    parsed.system = [
                      { type: "text", text: SYSTEM_IDENTITY },
                      { type: "text", text: parsed.system },
                    ]
                  }
                } else if (Array.isArray(parsed.system)) {
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

                body = JSON.stringify(parsed)
              } catch {
                // leave body as-is
              }
            }

            // Prefix tool names with mcp_ (required for proper routing)
            body = transformBody(body) ?? body

            const response = await fetchWithRetry(url, {
              method: init?.method ?? "POST",
              headers,
              body,
              signal: init?.signal,
            })

            return transformResponseStream(response)
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
