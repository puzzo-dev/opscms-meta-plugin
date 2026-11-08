import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'

/**
 * Meta credential encryption and OAuth state signing.
 *
 * Two things are protected here. Access tokens for every tenant's Facebook,
 * Instagram and Threads accounts are stored in the database, so they must be
 * encrypted at rest — a database dump otherwise hands over every tenant's social
 * accounts. And the OAuth round trip leaves this server, goes through Meta, and
 * comes back, with no session to carry the config id across; the state parameter
 * is signed so a forged or replayed callback cannot attach someone else's
 * Facebook Page to a config they do not own.
 *
 * The module reads its key at import time and caches it, so each test sets the
 * environment first and then resets the cache via the module's own test hook.
 */

/**
 * NODE_ENV is declared read-only by @types/node, but these tests must exercise
 * production-only branches (HTTPS enforcement, origin requirements). Assigning
 * through a widened view is the standard way to do that in a test.
 */
function setNodeEnv(value: string | undefined): void {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}


const KEY = 'a'.repeat(64) // 32 bytes as hex
const OTHER_KEY = 'b'.repeat(64)

const ORIGINAL_ENV = { ...process.env }

async function loadCrypto(env: Record<string, string | undefined> = {}) {
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    }
    // Cache-busting query so each load re-evaluates module-level state.
    const mod = await import(`../../src/utils/metaCrypto.js?t=${Math.random()}`)
    mod.__resetEncryptionKey()
    return mod
}

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
    delete process.env.META_ENCRYPTION_KEY
    delete process.env.META_OAUTH_STATE_SECRET
    delete process.env.META_APP_ID
    delete process.env.META_APP_SECRET
    setNodeEnv('test')
})

afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
})

describe('encryptCredential / decryptCredential', () => {
    it('round-trips an access token unchanged', async () => {
        const { encryptCredential, decryptCredential } = await loadCrypto({ META_ENCRYPTION_KEY: KEY })
        const token = 'EAAG1234567890abcdefghijklmnop'
        assert.equal(decryptCredential(encryptCredential(token)), token)
    })

    it('stores the token unreadable, not as plain text', async () => {
        const { encryptCredential } = await loadCrypto({ META_ENCRYPTION_KEY: KEY })
        const token = 'EAAG1234567890abcdefghijklmnop'
        const stored = encryptCredential(token)
        assert.ok(stored.startsWith('enc:'), 'encrypted values are marked with an enc: prefix')
        assert.ok(!stored.includes(token), 'the plain token must not appear in what is stored')
    })

    it('produces a different ciphertext each time, so identical tokens are not linkable', async () => {
        const { encryptCredential } = await loadCrypto({ META_ENCRYPTION_KEY: KEY })
        const a = encryptCredential('same-token')
        const b = encryptCredential('same-token')
        assert.notEqual(a, b, 'a fresh random IV must be used for every encryption')
    })

    it('does not double-encrypt a value that is already encrypted', async () => {
        const { encryptCredential } = await loadCrypto({ META_ENCRYPTION_KEY: KEY })
        const once = encryptCredential('token')
        assert.equal(encryptCredential(once), once)
    })

    it('cannot be decrypted with a different key', async () => {
        const { encryptCredential } = await loadCrypto({ META_ENCRYPTION_KEY: KEY })
        const stored = encryptCredential('token')

        const other = await loadCrypto({ META_ENCRYPTION_KEY: OTHER_KEY })
        // AES-GCM authenticates the ciphertext, so a wrong key fails rather than
        // returning wrong plaintext. Either outcome is acceptable as long as the
        // real token is never revealed.
        let result: string
        try {
            result = other.decryptCredential(stored)
        } catch {
            return // rejecting outright is the ideal outcome
        }
        assert.notEqual(result, 'token', 'a wrong key must never yield the real token')
    })

    it('passes a value through untouched when no key is configured', async () => {
        // Local development without META_ENCRYPTION_KEY must still work.
        const { encryptCredential, decryptCredential } = await loadCrypto({ META_ENCRYPTION_KEY: undefined })
        assert.equal(encryptCredential('token'), 'token')
        assert.equal(decryptCredential('token'), 'token')
    })

    it('rejects a key that is not exactly 32 bytes', async () => {
        await assert.rejects(async () => {
            const mod = await loadCrypto({ META_ENCRYPTION_KEY: 'abcd' })
            mod.encryptCredential('x')
        }, /32 bytes/)
    })

    it('leaves an unencrypted legacy value readable', async () => {
        // Rows written before encryption was added have no enc: prefix.
        const { decryptCredential } = await loadCrypto({ META_ENCRYPTION_KEY: KEY })
        assert.equal(decryptCredential('legacy-plain-token'), 'legacy-plain-token')
    })
})

describe('signOAuthState / verifyOAuthState', () => {
    it('recovers the config id from a state token it signed', async () => {
        const { signOAuthState, verifyOAuthState } = await loadCrypto({ META_OAUTH_STATE_SECRET: KEY })
        assert.equal(verifyOAuthState(signOAuthState('config-42')), 'config-42')
    })

    it('accepts a numeric config id', async () => {
        const { signOAuthState, verifyOAuthState } = await loadCrypto({ META_OAUTH_STATE_SECRET: KEY })
        assert.equal(verifyOAuthState(signOAuthState(42)), '42')
    })

    it('rejects a state token whose config id has been altered', async () => {
        // Without this, an attacker could complete OAuth and attach their own
        // Facebook Page to another tenant's Meta config.
        const { signOAuthState, verifyOAuthState } = await loadCrypto({ META_OAUTH_STATE_SECRET: KEY })
        const token = signOAuthState('config-1')
        const decoded = Buffer.from(token, 'base64url').toString('utf8')
        const [, timestamp, sig] = decoded.split(':')
        const forged = Buffer.from(`config-999:${timestamp}:${sig}`).toString('base64url')
        assert.equal(verifyOAuthState(forged), null)
    })

    it('rejects a state token signed with a different secret', async () => {
        const signer = await loadCrypto({ META_OAUTH_STATE_SECRET: KEY })
        const token = signer.signOAuthState('config-1')
        const verifier = await loadCrypto({ META_OAUTH_STATE_SECRET: OTHER_KEY })
        assert.equal(verifier.verifyOAuthState(token), null)
    })

    it('rejects malformed state values instead of throwing', async () => {
        const { verifyOAuthState } = await loadCrypto({ META_OAUTH_STATE_SECRET: KEY })
        for (const bad of ['', 'not-base64url!!', Buffer.from('a:b').toString('base64url'), Buffer.from('a:b:c:d').toString('base64url')]) {
            assert.equal(verifyOAuthState(bad), null, `should reject ${JSON.stringify(bad)}`)
        }
    })

    it('rejects a state token older than its ten-minute lifetime', async () => {
        const { verifyOAuthState } = await loadCrypto({ META_OAUTH_STATE_SECRET: KEY })
        const { createHmac } = await import('node:crypto')
        const elevenMinutesAgo = Date.now() - 11 * 60 * 1000
        const payload = `config-1:${elevenMinutesAgo}`
        const sig = createHmac('sha256', KEY).update(payload).digest('hex')
        const stale = Buffer.from(`${payload}:${sig}`).toString('base64url')
        assert.equal(verifyOAuthState(stale), null, 'an expired token must not be replayable')
    })

    it('falls back to the encryption key when no dedicated state secret is set', async () => {
        const { signOAuthState, verifyOAuthState } = await loadCrypto({
            META_ENCRYPTION_KEY: KEY,
            META_OAUTH_STATE_SECRET: undefined,
        })
        assert.equal(verifyOAuthState(signOAuthState('config-7')), 'config-7')
    })
})

describe('getMetaAppCredentials / getMaskedMetaAppId', () => {
    it('returns null when the Meta App is not configured', async () => {
        const { getMetaAppCredentials, getMaskedMetaAppId } = await loadCrypto({})
        assert.equal(getMetaAppCredentials(), null)
        assert.equal(getMaskedMetaAppId(), null)
    })

    it('reads the App ID and Secret from the environment', async () => {
        const { getMetaAppCredentials } = await loadCrypto({
            META_APP_ID: '1234567890',
            META_APP_SECRET: 'super-secret',
        })
        assert.deepEqual(getMetaAppCredentials(), { appId: '1234567890', appSecret: 'super-secret' })
    })

    it('requires both halves — an App ID alone is not usable', async () => {
        const { getMetaAppCredentials } = await loadCrypto({
            META_APP_ID: '1234567890',
            META_APP_SECRET: undefined,
        })
        assert.equal(getMetaAppCredentials(), null)
    })

    it('masks the App ID down to its last four characters', async () => {
        const { getMaskedMetaAppId } = await loadCrypto({
            META_APP_ID: '1234567890',
            META_APP_SECRET: 'x',
        })
        assert.equal(getMaskedMetaAppId(), '••••7890')
    })

    it('never exposes the App Secret through the masking helper', async () => {
        const { getMaskedMetaAppId } = await loadCrypto({
            META_APP_ID: '1234567890',
            META_APP_SECRET: 'super-secret',
        })
        assert.ok(!String(getMaskedMetaAppId()).includes('super-secret'))
    })
})
