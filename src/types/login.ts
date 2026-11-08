import type { PayloadRequest } from 'payload'

/**
 * Signing in to the platform with a Facebook account (src/login, src/endpoints/metaLogin.ts).
 */

/** What Facebook tells the platform about the person who just signed in. */
export interface FacebookProfile {
    id: string
    name?: string
    email?: string
}

/** Why a Facebook sign-in did not become a platform sign-in. Each is a fixed code the login page turns into a sentence. */
export type FacebookLoginFailure =
    /** The person said no on Facebook's screen. */
    | 'denied'
    /** The sign-in did not start here, or took too long (the safety check against forged sign-ins failed). */
    | 'state'
    /** Facebook did not give an email, and the account is not already linked. */
    | 'no_email'
    /** No platform account has that email. Accounts are made by invitation, never by signing in. */
    | 'no_account'
    /** The account is suspended. */
    | 'suspended'
    /** The platform owner (super-admin) signs in with email, password and, if switched on, a two-factor code. Never through Facebook. */
    | 'not_allowed'
    /** The account has two-factor sign-in switched on, which Facebook sign-in cannot satisfy: use the password and the code. */
    | 'two_factor'
    /** The platform account is already linked to a different Facebook account. */
    | 'conflict'
    /** Meta is not set up on this server. */
    | 'not_configured'
    /** Anything else: Facebook or the platform could not complete it. */
    | 'failed'

export type LoginResolution =
    | { ok: true; user: Record<string, unknown>; linked: boolean }
    | { ok: false; code: Extract<FacebookLoginFailure, 'no_email' | 'no_account' | 'suspended' | 'not_allowed' | 'two_factor' | 'conflict' | 'failed'> }

export type GraphProfileResult = { ok: true; profile: FacebookProfile } | { ok: false; error: string }
export type GraphTokenResult = { ok: true; accessToken: string } | { ok: false; error: string }

/** A signed-in session ready to hand to the browser. */
export interface LoginSession {
    token: string
    /** The `Set-Cookie` value for the platform's own token cookie. */
    cookie: string
}

export interface LoginContext {
    req: PayloadRequest
    /** The collection people sign in to (`users` unless the platform changed it). */
    usersSlug: string
}
