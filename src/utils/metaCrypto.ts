/**
 * Meta Credential Encryption
 *
 * Provides AES-256-GCM encryption for Meta (App Secret, Access Token) credentials
 * stored in the database. Credentials are encrypted before save and decrypted
 * after read. Same scheme as opscms-erpnext-plugin/src/utils/erpnextCrypto.ts,
 * with its own key so rotating one plugin's key doesn't affect the other.
 *
 * CANONICAL SOURCE: `@ivarse/shared-cms/credential-crypto` holds the
 * authoritative `createCredentialCrypto` factory. This plugin is a separately
 * published package and cannot import from the workspace-only shared-cms, so
 * the crypto logic is mirrored here. When the logic changes, update shared-cms
 * first, then mirror it here. The CMS's `src/utils/credentialCrypto.ts` imports
 * directly from shared-cms and needs no manual sync.
 *
 * Requires META_ENCRYPTION_KEY env var (32-byte hex string).
 * If the key is not set, credentials are stored/read in plain text (backward compatible).
 *
 * Key generation: openssl rand -hex 32
 */

import { createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // GCM standard
const PREFIX = 'enc:' // Marker to detect already-encrypted values

let cachedKey: Buffer | null = null
let initialized = false

function getEncryptionKey(): Buffer | null {
    if (initialized) return cachedKey

    const hex = process.env.META_ENCRYPTION_KEY
    if (!hex) {
        // Fail-fast in production: storing Meta access tokens in plain text means any
        // DB dump/backup leaks every tenant's Meta credentials. Require an explicit
        // opt-out for the rare legitimate case (e.g. throwaway dev-like environments).
        if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PLAINTEXT_META_CREDS !== 'true') {
            throw new Error(
                '[meta-crypto] FATAL: META_ENCRYPTION_KEY is required in production ' +
                '(generate with `openssl rand -hex 32`). Set ALLOW_PLAINTEXT_META_CREDS=true to knowingly store credentials in plain text.',
            )
        }
        if (process.env.NODE_ENV === 'production') {
            console.warn('[meta-crypto] META_ENCRYPTION_KEY not set — Meta credentials will be stored in plain text (ALLOW_PLAINTEXT_META_CREDS=true).')
        }
        initialized = true
        return null
    }

    const buf = Buffer.from(hex, 'hex')
    if (buf.length !== 32) {
        throw new Error('[meta-crypto] FATAL: META_ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars).')
    }

    cachedKey = buf
    initialized = true
    return cachedKey
}

// Invoke immediately on module load to fail-fast if misconfigured.
getEncryptionKey()

/**
 * Test-only helper: drop every cached secret so the next call re-reads the
 * environment.
 *
 * This used to clear only the encryption key, leaving `cachedStateSecret`
 * populated from a previous load. A test that changed META_OAUTH_STATE_SECRET
 * and expected the new value silently kept verifying against the old one — so a
 * test asserting that a token signed with a different secret is rejected passed
 * for the wrong reason, or failed confusingly. Both caches are cleared here.
 */
export function __resetEncryptionKey(): void {
    cachedKey = null
    initialized = false
    cachedStateSecret = null
}

/**
 * Encrypt a plain-text credential. Returns a string prefixed with "enc:".
 * If encryption key is not configured, returns the value as-is.
 */
export function encryptCredential(plaintext: string): string {
    const key = getEncryptionKey()
    if (!key) return plaintext
    if (plaintext.startsWith(PREFIX)) return plaintext // Already encrypted

    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()

    // Format: enc:<iv_hex>:<tag_hex>:<ciphertext_hex>
    return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

/**
 * Decrypt an encrypted credential. If the value doesn't have the "enc:" prefix,
 * it's assumed to be plain text (backward compatible).
 */
export function decryptCredential(stored: string): string {
    const key = getEncryptionKey()
    if (!key) return stored
    if (!stored.startsWith(PREFIX)) return stored // Plain text (pre-encryption)

    try {
        const payload = stored.slice(PREFIX.length)
        const [ivHex, tagHex, ciphertextHex] = payload.split(':')
        if (!ivHex || !tagHex || !ciphertextHex) return stored

        const iv = Buffer.from(ivHex, 'hex')
        const tag = Buffer.from(tagHex, 'hex')
        const ciphertext = Buffer.from(ciphertextHex, 'hex')

        const decipher = createDecipheriv(ALGORITHM, key, iv)
        decipher.setAuthTag(tag)
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
        return decrypted.toString('utf8')
    } catch (err) {
        console.error('[meta-crypto] Failed to decrypt credential:', err)
        return stored // Return raw value on failure — don't break the system
    }
}

// ── Platform Meta App credentials ────────────────────────────────────
//
// One Meta App (created once, by hand, in developers.facebook.com — there is
// no public Graph API to create an App programmatically, unlike ERPNext's
// OAuth Client doctype) serves every tenant site, same pattern as Buffer/
// Hootsuite/Zapier: the App ID/Secret identify the INTEGRATION, not any one
// site's Facebook Page — each site still does its own OAuth consent to link
// its own Page/IG/Pixel. Read directly from env (not per-site DB fields) so
// no site owner ever needs to create a Meta App or handle a Secret.

export function getMetaAppCredentials(): { appId: string; appSecret: string } | null {
    const appId = process.env.META_APP_ID
    const appSecret = process.env.META_APP_SECRET
    if (!appId || !appSecret) return null
    return { appId, appSecret }
}

/** App ID isn't actually secret (it's public in every OAuth URL), but masked for a consistent "populated, not fully shown" UI treatment. */
export function getMaskedMetaAppId(): string | null {
    const creds = getMetaAppCredentials()
    if (!creds) return null
    return creds.appId.length > 4 ? `••••${creds.appId.slice(-4)}` : '••••'
}

// ── OAuth state signing ──────────────────────────────────────────────
//
// The OAuth authorize→callback round trip goes through Meta's (or Threads')
// servers and back — there's no server-side session to carry the configId
// across that redirect. Instead of a session store, sign `configId:timestamp`
// with an HMAC so the callback can verify the state param wasn't forged or
// replayed from an old request, without any server-side state.

const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes — long enough for a user to complete the OAuth consent screen

let cachedStateSecret: string | null = null

function getStateSecret(): string {
    if (cachedStateSecret) return cachedStateSecret
    const fromEnv = process.env.META_OAUTH_STATE_SECRET || process.env.META_ENCRYPTION_KEY
    if (fromEnv) {
        cachedStateSecret = fromEnv
        return cachedStateSecret
    }
    if (process.env.NODE_ENV === 'production') {
        throw new Error(
            '[meta-crypto] FATAL: META_OAUTH_STATE_SECRET or META_ENCRYPTION_KEY is required ' +
            'for OAuth state signing in production.',
        )
    }
    // Dev-only: generate an ephemeral random secret so HMAC works without a hardcoded value.
    // This secret is per-process and won't survive restarts, which is fine for local dev.
    cachedStateSecret = randomBytes(32).toString('hex')
    return cachedStateSecret
}

/** Sign a configId into an opaque, tamper-evident state token for the OAuth `state` param. */
export function signOAuthState(configId: string | number): string {
    const payload = `${configId}:${Date.now()}`
    const sig = createHmac('sha256', getStateSecret()).update(payload).digest('hex')
    return Buffer.from(`${payload}:${sig}`).toString('base64url')
}

/** Verify and decode a state token. Returns the configId, or null if invalid/expired/tampered. */
export function verifyOAuthState(state: string): string | null {
    try {
        const decoded = Buffer.from(state, 'base64url').toString('utf8')
        const parts = decoded.split(':')
        if (parts.length !== 3) return null
        const [configId, timestampStr, sig] = parts
        const payload = `${configId}:${timestampStr}`
        const expected = createHmac('sha256', getStateSecret()).update(payload).digest('hex')

        const a = Buffer.from(sig)
        const b = Buffer.from(expected)
        if (a.length !== b.length || !timingSafeEqual(a, b)) return null

        const timestamp = Number(timestampStr)
        if (!Number.isFinite(timestamp) || Date.now() - timestamp > STATE_TTL_MS) return null

        return configId
    } catch {
        return null
    }
}
