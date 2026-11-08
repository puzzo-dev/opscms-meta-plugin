import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The safety check against forged sign-ins.
 *
 * Starting a sign-in sets a one-time random value in this browser's cookie and sends the same value to Facebook as `state`.
 * Facebook sends it back, and only a browser holding the cookie can match it. Without this, someone could start a sign-in with
 * their own Facebook account and trick a visitor into finishing it, signing the visitor in as them.
 */

export const STATE_COOKIE = 'opscms-fb-state'
const STATE_MAX_AGE_SECONDS = 600
const COOKIE_PATH = '/api/meta-login'

export const newState = (): string => randomBytes(24).toString('hex')

export function stateCookie(value: string, secure: boolean): string {
    return `${STATE_COOKIE}=${value}; Path=${COOKIE_PATH}; Max-Age=${STATE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

export function clearedStateCookie(secure: boolean): string {
    return `${STATE_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

export function readCookie(header: string | null | undefined, name: string): string | null {
    if (!header) return null
    for (const part of header.split(';')) {
        const index = part.indexOf('=')
        if (index < 0) continue
        if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
    }
    return null
}

/** Whether the value Facebook sent back is the one this browser was given. Constant time. */
export function statesMatch(fromFacebook: string | undefined | null, fromCookie: string | null): boolean {
    if (!fromFacebook || !fromCookie) return false
    const a = Buffer.from(fromFacebook)
    const b = Buffer.from(fromCookie)
    return a.length === b.length && timingSafeEqual(a, b)
}
