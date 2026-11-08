import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { APIError } from 'payload'
import type { Payload, PayloadRequest } from 'payload'

import { createMetaLoginEndpoints } from '../endpoints/metaLogin'
import type { Endpoint } from 'payload'
import { fetchLoginProfile, exchangeLoginCode } from './facebook'
import { resolveLoginUser } from './resolveUser'
import { clearedStateCookie, newState, readCookie, STATE_COOKIE, stateCookie, statesMatch } from './state'

/**
 * Signing in to the platform with Facebook. Facebook's answers are faked; Payload's own session code is the real one.
 */

type User = Record<string, unknown> & { id: number; email: string }

const users: User[] = []
const writes: Array<{ id: number; data: Record<string, unknown> }> = []
const sessionWrites: Array<Record<string, unknown>> = []
const logs: string[] = []
let rateAllowed = true
let beforeLoginRefuses = false
const afterLoginSeen: string[] = []

const matches = (user: User, where: Record<string, { equals: unknown }>): boolean =>
    Object.entries(where).every(([field, condition]) => user[field] === condition.equals)

const fakePayload = (): Payload =>
    ({
        secret: 'test-secret-test-secret-test-secret',
        config: { cookiePrefix: 'payload', admin: { user: 'users' } },
        logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: unknown) => logs.push(String(m)) },
        find: async ({ where }: { where: Record<string, { equals: unknown }> }) => ({ docs: users.filter((u) => matches(u, where)).slice(0, 1).map((u) => ({ ...u })) }),
        update: async ({ id, data }: { id: number; data: Record<string, unknown> }) => {
            writes.push({ id, data })
            Object.assign(users.find((u) => u.id === id) as User, data)
        },
        db: { updateOne: async ({ data }: { data: Record<string, unknown> }) => void sessionWrites.push(JSON.parse(JSON.stringify(data))) },
        collections: {
            users: {
                config: {
                    slug: 'users',
                    fields: [{ name: 'email', type: 'email' }, { name: 'role', type: 'text', saveToJWT: true }],
                    auth: { useSessions: true, tokenExpiration: 1800, cookies: { secure: false, sameSite: 'Lax' } },
                    hooks: {
                        beforeLogin: [({ user }: { user: User }) => {
                            if (beforeLoginRefuses) throw new APIError('This account has been suspended. Contact the platform administrator.', 403, undefined, true)
                            void user
                        }],
                        afterLogin: [({ user }: { user: User }) => void afterLoginSeen.push(user.email)],
                    },
                },
            },
        },
    }) as unknown as Payload

const reqFor = (url: string, options: { cookie?: string; user?: unknown } = {}): PayloadRequest => {
    const parsed = new URL(url)
    return {
        url,
        query: Object.fromEntries(parsed.searchParams),
        headers: new Headers(options.cookie ? { cookie: options.cookie } : {}),
        payload: fakePayload(),
        user: options.user ?? null,
        context: {},
    } as unknown as PayloadRequest
}

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const realFetch = globalThis.fetch
let facebook: (url: string) => Response
const calls: string[] = []

beforeEach(() => {
    users.length = 0
    writes.length = 0
    sessionWrites.length = 0
    logs.length = 0
    afterLoginSeen.length = 0
    calls.length = 0
    rateAllowed = true
    beforeLoginRefuses = false
    process.env.META_APP_ID = '111'
    process.env.META_APP_SECRET = 'app-secret'
    process.env.PAYLOAD_PUBLIC_SERVER_URL = 'https://cms.example.test'
    facebook = (url) => {
        if (url.includes('/oauth/access_token')) return respond({ access_token: 'user-token' })
        if (url.includes('/me?')) return respond({ id: 'fb-1', name: 'Ada', email: 'Ada@Example.test' })
        return respond({ error: { message: 'unexpected' } }, 400)
    }
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input)
        calls.push(url)
        return facebook(url)
    }) as typeof fetch
})
afterEach(() => {
    globalThis.fetch = realFetch
})

const host = () => ({
    emitSystemEvent: async () => ({ enqueued: 0, failed: 0 }),
    ensureEventHandler: async () => {},
    rateLimit: { check: async () => ({ allowed: rateAllowed }), clientIp: () => '203.0.113.9' },
})
const endpoints = () => {
    const list = createMetaLoginEndpoints(host() as never)
    const by = (method: string, path: string) => list.find((e) => e.method === method && e.path === path) as Endpoint
    return { status: by('get', '/meta-login/status'), start: by('get', '/meta-login/start'), callback: by('get', '/meta-login/callback'), unlink: by('post', '/meta-login/unlink') }
}
const cookiesOf = (response: Response) => response.headers.getSetCookie()

describe('the safety check against forged sign-ins', () => {
    it('sets a one-time browser cookie that only a matching state can pass', () => {
        const state = newState()
        assert.match(state, /^[a-f0-9]{48}$/)
        assert.notEqual(newState(), state)
        const cookie = stateCookie(state, true)
        assert.match(cookie, /HttpOnly/)
        assert.match(cookie, /SameSite=Lax/)
        assert.match(cookie, /Secure/)
        assert.match(cookie, /Path=\/api\/meta-login/)
        assert.doesNotMatch(stateCookie(state, false), /Secure/)
        assert.match(clearedStateCookie(false), /Max-Age=0/)
        assert.equal(readCookie(`a=1; ${STATE_COOKIE}=${state}; b=2`, STATE_COOKIE), state)
        assert.equal(statesMatch(state, state), true)
        for (const [fromFacebook, fromCookie] of [[state, 'other'], [undefined, state], [state, null], ['', ''], [state.slice(1), state]] as const) {
            assert.equal(statesMatch(fromFacebook, fromCookie), false)
        }
    })
})

describe('asking Facebook who signed in', () => {
    it('exchanges the code with the app secret, and reads the profile with a proof the request is ours', async () => {
        const token = await exchangeLoginCode('the-code', { appId: '111', appSecret: 'app-secret' }, 'https://cms.example.test/api/meta-login/callback')
        assert.deepEqual(token, { ok: true, accessToken: 'user-token' })
        assert.match(calls[0], /client_secret=app-secret/)
        assert.match(calls[0], /code=the-code/)
        const profile = await fetchLoginProfile('user-token', 'app-secret')
        assert.deepEqual(profile, { ok: true, profile: { id: 'fb-1', name: 'Ada', email: 'ada@example.test' } })
        assert.match(calls[1], /appsecret_proof=[a-f0-9]{64}/)
        assert.match(calls[1], /fields=id%2Cname%2Cemail/)
    })

    it('reports a refusal from Facebook, and a profile with no email', async () => {
        facebook = () => respond({ error: { message: 'Invalid verification code' } }, 400)
        const bad = await exchangeLoginCode('x', { appId: '1', appSecret: 's' }, 'u')
        assert.equal(bad.ok, false)
        facebook = () => respond({ id: 'fb-2', name: 'No Email' })
        assert.deepEqual(await fetchLoginProfile('t', 's'), { ok: true, profile: { id: 'fb-2', name: 'No Email' } })
    })
})

describe('which account a Facebook sign-in belongs to', () => {
    const resolve = (profile: { id: string; email?: string }) => resolveLoginUser(fakePayload(), 'users', profile)

    it('goes by the Facebook id once linked, whatever the email is now', async () => {
        users.push({ id: 1, email: 'old@example.test', facebookId: 'fb-1' })
        const result = await resolve({ id: 'fb-1', email: 'different@example.test' })
        assert.equal(result.ok && result.user.id, 1)
        assert.equal(result.ok && result.linked, false)
        assert.deepEqual(writes, [])
    })

    it('joins an account whose email is the same, and remembers the link', async () => {
        users.push({ id: 2, email: 'ada@example.test' })
        const result = await resolve({ id: 'fb-1', email: 'ada@example.test' })
        assert.equal(result.ok && result.linked, true)
        assert.deepEqual(writes, [{ id: 2, data: { facebookId: 'fb-1' } }])
        assert.equal(users[0].facebookId, 'fb-1')
    })

    it('never joins on a different email, and never creates an account', async () => {
        users.push({ id: 3, email: 'someone@example.test' })
        assert.deepEqual(await resolve({ id: 'fb-9', email: 'stranger@example.test' }), { ok: false, code: 'no_account' })
        assert.deepEqual(await resolve({ id: 'fb-9' }), { ok: false, code: 'no_email' })
        assert.deepEqual(writes, [])
        assert.equal(users.length, 1)
    })

    it('turns away a suspended account, and one already linked to a different Facebook account', async () => {
        users.push({ id: 4, email: 'sus@example.test', suspended: true })
        assert.deepEqual(await resolve({ id: 'fb-4', email: 'sus@example.test' }), { ok: false, code: 'suspended' })
        users.push({ id: 5, email: 'taken@example.test', facebookId: 'someone-else' })
        assert.deepEqual(await resolve({ id: 'fb-5', email: 'taken@example.test' }), { ok: false, code: 'conflict' })
        assert.equal(users.find((u) => u.id === 5)?.facebookId, 'someone-else', 'the existing link is not overwritten')
    })
})

describe('accounts that never sign in through Facebook', () => {
    const resolve = (profile: { id: string; email?: string }) => resolveLoginUser(fakePayload(), 'users', profile)

    it('turns away the platform owner, by email and by an existing link, and links nothing', async () => {
        users.push({ id: 10, email: 'owner@example.test', role: 'super-admin' })
        assert.deepEqual(await resolve({ id: 'fb-10', email: 'owner@example.test' }), { ok: false, code: 'not_allowed' })
        users.push({ id: 11, email: 'linked-owner@example.test', role: 'super-admin', facebookId: 'fb-11' })
        assert.deepEqual(await resolve({ id: 'fb-11', email: 'linked-owner@example.test' }), { ok: false, code: 'not_allowed' })
        assert.deepEqual(writes, [])
        assert.equal(users.find((u) => u.id === 10)?.facebookId, undefined)
    })

    it('turns away an account with two-factor sign-in on, because Facebook cannot give the code', async () => {
        users.push({ id: 12, email: 'safe@example.test', role: 'admin', twoFactorEnabled: true })
        assert.deepEqual(await resolve({ id: 'fb-12', email: 'safe@example.test' }), { ok: false, code: 'two_factor' })
        users.push({ id: 13, email: 'safe2@example.test', role: 'editor', twoFactorEnabled: true, facebookId: 'fb-13' })
        assert.deepEqual(await resolve({ id: 'fb-13', email: 'safe2@example.test' }), { ok: false, code: 'two_factor' })
        assert.deepEqual(writes, [])
    })

    it('still lets an ordinary admin or editor in', async () => {
        users.push({ id: 14, email: 'plain@example.test', role: 'admin', twoFactorEnabled: false })
        const result = await resolve({ id: 'fb-14', email: 'plain@example.test' })
        assert.equal(result.ok, true)
    })
})

describe('starting a sign-in', () => {
    it('says whether Meta is set up here', async () => {
        assert.deepEqual(await (await endpoints().status.handler(reqFor('https://cms.example.test/api/meta-login/status'))).json(), { enabled: true })
        delete process.env.META_APP_SECRET
        assert.deepEqual(await (await endpoints().status.handler(reqFor('https://cms.example.test/api/meta-login/status'))).json(), { enabled: false })
    })

    it('sends the browser to Facebook for name and email only, with a state that matches the cookie it sets', async () => {
        const response = await endpoints().start.handler(reqFor('https://cms.example.test/api/meta-login/start'))
        assert.equal(response.status, 302)
        const location = new URL(response.headers.get('location') as string)
        assert.equal(location.hostname, 'www.facebook.com')
        assert.equal(location.searchParams.get('client_id'), '111')
        assert.equal(location.searchParams.get('scope'), 'email,public_profile')
        assert.equal(location.searchParams.get('redirect_uri'), 'https://cms.example.test/api/meta-login/callback')
        const state = location.searchParams.get('state') as string
        assert.ok(cookiesOf(response)[0].startsWith(`${STATE_COOKIE}=${state};`))
    })

    it('goes back to the login page when Meta is not set up, and is throttled', async () => {
        delete process.env.META_APP_ID
        const off = await endpoints().start.handler(reqFor('https://cms.example.test/api/meta-login/start'))
        assert.equal(off.headers.get('location'), 'https://cms.example.test/admin/login?fb_error=not_configured')
        process.env.META_APP_ID = '111'
        rateAllowed = false
        assert.equal((await endpoints().start.handler(reqFor('https://cms.example.test/api/meta-login/start'))).status, 429)
    })
})

describe('finishing a sign-in', () => {
    const callbackUrl = (extra = 'code=abc&state=S1') => `https://cms.example.test/api/meta-login/callback?${extra}`
    const withCookie = `${STATE_COOKIE}=S1`
    const finishWith = (url: string, cookie?: string) => endpoints().callback.handler(reqFor(url, { cookie }))
    const to = (response: Response) => response.headers.get('location')

    it('signs the person in as the account with the same email, with a real session and token', async () => {
        users.push({ id: 7, email: 'ada@example.test', role: 'admin' })
        const response = await finishWith(callbackUrl(), withCookie)
        assert.equal(response.status, 302)
        assert.equal(to(response), 'https://cms.example.test/admin')
        const cookies = cookiesOf(response)
        const token = cookies.find((c) => c.startsWith('payload-token='))
        assert.ok(token, 'the platform\'s own token cookie is set')
        assert.match(token as string, /HttpOnly/)
        assert.match(token as string, /Secure/, 'secure on an https server')
        assert.ok(cookies.some((c) => c.startsWith(`${STATE_COOKIE}=;`)), 'the one-time cookie is cleared')

        const claims = JSON.parse(Buffer.from((token as string).split('=')[1].split(';')[0].split('.')[1], 'base64url').toString())
        assert.equal(claims.id, 7)
        assert.equal(claims.collection, 'users')
        assert.equal(claims.email, 'ada@example.test')
        assert.equal(claims.role, 'admin')
        assert.ok(claims.sid, 'tied to a session')
        const stored = sessionWrites[0].sessions as Array<{ id: string }>
        assert.equal(stored[stored.length - 1].id, claims.sid, 'the session the token names is the one that was stored')
        assert.deepEqual(afterLoginSeen, ['ada@example.test'], 'the platform\'s own after-login hook ran')
        assert.equal(users[0].facebookId, 'fb-1', 'the accounts are joined')
    })

    it('refuses a sign-in that did not start in this browser, or came back wrong, without calling Facebook', async () => {
        for (const [url, cookie] of [[callbackUrl(), undefined], [callbackUrl(), `${STATE_COOKIE}=OTHER`], [callbackUrl('code=abc'), withCookie], [callbackUrl('state=S1'), withCookie]] as const) {
            const response = await finishWith(url, cookie)
            assert.equal(to(response), 'https://cms.example.test/admin/login?fb_error=state')
            assert.ok(!cookiesOf(response).some((c) => c.startsWith('payload-token=')))
        }
        assert.equal(calls.length, 0)
    })

    it('says so when the person cancelled on Facebook', async () => {
        assert.equal(to(await finishWith(callbackUrl('error=access_denied&error_reason=user_denied'), withCookie)), 'https://cms.example.test/admin/login?fb_error=denied')
    })

    it('sends the person back with a plain reason when there is no matching account, no email, or the account is suspended', async () => {
        assert.equal(to(await finishWith(callbackUrl(), withCookie)), 'https://cms.example.test/admin/login?fb_error=no_account')
        facebook = (url) => (url.includes('/me?') ? respond({ id: 'fb-3', name: 'Nameless' }) : respond({ access_token: 't' }))
        assert.equal(to(await finishWith(callbackUrl(), withCookie)), 'https://cms.example.test/admin/login?fb_error=no_email')
        facebook = (url) => (url.includes('/me?') ? respond({ id: 'fb-1', email: 'ada@example.test' }) : respond({ access_token: 't' }))
        users.push({ id: 8, email: 'ada@example.test', suspended: true })
        assert.equal(to(await finishWith(callbackUrl(), withCookie)), 'https://cms.example.test/admin/login?fb_error=suspended')
        assert.equal(sessionWrites.length, 0, 'no session was created for any of these')
    })

    it('honours the platform\'s own sign-in refusal (a suspended account), and creates no usable cookie', async () => {
        users.push({ id: 9, email: 'ada@example.test', role: 'admin' })
        beforeLoginRefuses = true
        const response = await finishWith(callbackUrl(), withCookie)
        assert.equal(to(response), 'https://cms.example.test/admin/login?fb_error=suspended')
        assert.ok(!cookiesOf(response).some((c) => c.startsWith('payload-token=')))
        assert.equal(sessionWrites.length, 0)
    })

    it('says "failed" when Facebook rejects the code, and never reflects what the request said', async () => {
        facebook = () => respond({ error: { message: '<script>alert(1)</script>' } }, 400)
        const response = await finishWith(callbackUrl('code=bad&state=S1&fb_error=hacked'), withCookie)
        assert.equal(to(response), 'https://cms.example.test/admin/login?fb_error=failed')
        assert.ok(!(to(response) as string).includes('script'))
    })
})

describe('disconnecting Facebook', () => {
    it('lets a signed-in person clear the link on their own account, and no one else', async () => {
        users.push({ id: 11, email: 'ada@example.test', facebookId: 'fb-1' })
        assert.equal((await endpoints().unlink.handler(reqFor('https://cms.example.test/api/meta-login/unlink'))).status, 401)
        const response = await endpoints().unlink.handler(reqFor('https://cms.example.test/api/meta-login/unlink', { user: { id: 11 } }))
        assert.equal(response.status, 200)
        assert.deepEqual(writes, [{ id: 11, data: { facebookId: null } }])
    })
})
