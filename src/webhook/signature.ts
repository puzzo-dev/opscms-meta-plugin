import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The two checks Meta's webhooks need.
 *
 * Handshake: when a callback is registered, Meta calls it with `hub.mode=subscribe`, `hub.verify_token` and `hub.challenge`.
 * The answer is the challenge, but only if the token is the one the platform chose.
 *
 * Signature: every delivery carries `X-Hub-Signature-256: sha256=<hex>`, the HMAC-SHA256 of the raw body with the app secret.
 * Anything that does not match is not from Meta and is refused before the body is read as data.
 */

/** The challenge to answer with, or null when the request is not a valid handshake for this token. */
export function handshakeChallenge(query: Record<string, unknown> | undefined, verifyToken: string | undefined): string | null {
    if (!verifyToken) return null
    const mode = query?.['hub.mode']
    const token = query?.['hub.verify_token']
    const challenge = query?.['hub.challenge']
    if (mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string') return null
    const a = Buffer.from(token)
    const b = Buffer.from(verifyToken)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    return challenge
}

/** Whether the header is Meta's signature of this exact body under this app secret. */
export function signatureMatches(rawBody: string, header: string | null | undefined, appSecret: string): boolean {
    if (!header || !appSecret) return false
    const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim())
    if (!match) return false
    const expected = createHmac('sha256', appSecret).update(rawBody).digest()
    const provided = Buffer.from(match[1], 'hex')
    return provided.length === expected.length && timingSafeEqual(provided, expected)
}
