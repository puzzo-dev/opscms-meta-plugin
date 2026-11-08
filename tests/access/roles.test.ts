import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'

/**
 * Access control for the Meta config collection.
 *
 * Every row here holds one tenant's Facebook, Instagram and Threads access
 * tokens, so the isolation between tenants is the whole point: an editor on one
 * site must never be able to read, change or delete another site's Meta
 * connection.
 *
 * The reads use a filter (Payload applies it as a WHERE clause) while create
 * uses a boolean, because there is no document to filter on yet — so create
 * checks the site being written instead.
 */

const INTERNAL_SECRET = 'internal-secret-for-meta-plugin-tests'
const ORIGINAL_ENV = { ...process.env }

let roles: typeof import('../../src/access/roles.js')

beforeEach(async () => {
    process.env.INTERNAL_API_SECRET = INTERNAL_SECRET
    roles = await import('../../src/access/roles.js')
})

afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
})

const superAdmin = { id: 1, role: 'super-admin' as const }
const admin = { id: 2, role: 'admin' as const, site: 7 }
const editor = { id: 3, role: 'editor' as const, site: 7 }
const siteless = { id: 4, role: 'editor' as const }

function req(user: unknown, headers: Record<string, string> = {}) {
    return { req: { user, headers: new Headers(headers) } } as never
}

function reqWithData(user: unknown, data: Record<string, unknown>) {
    return { req: { user, headers: new Headers() }, data } as never
}

describe('siteScopedRead', () => {
    it('lets a super-admin see every site’s Meta config', () => {
        assert.equal(roles.siteScopedRead()(req(superAdmin)), true)
    })

    it('limits an editor to their own site', () => {
        assert.deepEqual(roles.siteScopedRead()(req(editor)), { site: { equals: 7 } })
    })

    it('limits an admin to their own site', () => {
        assert.deepEqual(roles.siteScopedRead()(req(admin)), { site: { equals: 7 } })
    })

    it('denies an anonymous request', () => {
        assert.equal(roles.siteScopedRead()(req(null)), false)
    })

    it('denies a user with no site assigned rather than showing them everything', () => {
        assert.equal(roles.siteScopedRead()(req(siteless)), false)
    })

    it('honours a custom site field name', () => {
        assert.deepEqual(roles.siteScopedRead('project')(req(editor)), { project: { equals: 7 } })
    })

    it('grants full access to an internal service call', () => {
        assert.equal(roles.siteScopedRead()(req(null, { 'x-internal-auth': INTERNAL_SECRET })), true)
    })

    it('ignores a wrong internal secret', () => {
        assert.equal(roles.siteScopedRead()(req(null, { 'x-internal-auth': 'wrong' })), false)
    })
})

describe('siteScopedCreate', () => {
    it('allows an editor to create a config for their own site', () => {
        assert.equal(roles.siteScopedCreate()(reqWithData(editor, { site: 7 })), true)
    })

    it('refuses an editor creating a config for a different site', () => {
        // This is the check that stops one tenant attaching a Meta connection
        // to another tenant's site.
        assert.equal(roles.siteScopedCreate()(reqWithData(editor, { site: 99 })), false)
    })

    it('refuses a create with no site at all', () => {
        assert.equal(roles.siteScopedCreate()(reqWithData(editor, {})), false)
        assert.equal(roles.siteScopedCreate()(reqWithData(editor, { site: '' })), false)
        assert.equal(roles.siteScopedCreate()(reqWithData(editor, { site: null })), false)
    })

    it('accepts a site supplied as a populated object rather than a bare id', () => {
        assert.equal(roles.siteScopedCreate()(reqWithData(editor, { site: { id: 7 } })), true)
    })

    it('compares ids as strings, so 7 and "7" are the same site', () => {
        assert.equal(roles.siteScopedCreate()(reqWithData(editor, { site: '7' })), true)
    })

    it('lets a super-admin create for any site', () => {
        assert.equal(roles.siteScopedCreate()(reqWithData(superAdmin, { site: 99 })), true)
    })

    it('denies an anonymous create', () => {
        assert.equal(roles.siteScopedCreate()(reqWithData(null, { site: 7 })), false)
    })
})

describe('siteScopedUpdate', () => {
    it('limits an editor to updating their own site’s config', () => {
        assert.deepEqual(roles.siteScopedUpdate()(req(editor)), { site: { equals: 7 } })
    })

    it('denies an anonymous update', () => {
        assert.equal(roles.siteScopedUpdate()(req(null)), false)
    })

    it('lets a super-admin update anything', () => {
        assert.equal(roles.siteScopedUpdate()(req(superAdmin)), true)
    })
})

describe('siteScopedDelete', () => {
    it('lets an admin delete their own site’s config', () => {
        assert.deepEqual(roles.siteScopedDelete()(req(admin)), { site: { equals: 7 } })
    })

    it('refuses an editor — deleting a Meta connection is an admin action', () => {
        assert.equal(roles.siteScopedDelete()(req(editor)), false)
    })

    it('lets a super-admin delete anything', () => {
        assert.equal(roles.siteScopedDelete()(req(superAdmin)), true)
    })

    it('denies an anonymous delete', () => {
        assert.equal(roles.siteScopedDelete()(req(null)), false)
    })
})

describe('organization admin (site owner)', () => {
    const owner = { id: 9, role: 'admin' as const, organization: 3 }
    const sites = {
        find: async () => ({ docs: [{ id: 11 }, { id: 12 }] }),
    }

    function ownerReq(data?: Record<string, unknown>) {
        const request = { user: owner, headers: new Headers(), payload: sites }
        return data ? { req: request, data } : { req: request }
    }

    it('lists every site in the organization', async () => {
        assert.deepEqual(await roles.siteScopedRead()(ownerReq() as never), { site: { in: [11, 12] } })
        assert.deepEqual(await roles.siteScopedUpdate()(ownerReq() as never), { site: { in: [11, 12] } })
        assert.deepEqual(await roles.siteScopedDelete()(ownerReq() as never), { site: { in: [11, 12] } })
    })

    it('creates a config only for a site in that organization', async () => {
        assert.equal(await roles.siteScopedCreate()(ownerReq({ site: 12 }) as never), true)
        assert.equal(await roles.siteScopedCreate()(ownerReq({ site: 99 }) as never), false)
    })

    it('denies the owner when their sites cannot be resolved', async () => {
        const request = { user: owner, headers: new Headers() }
        assert.equal(await roles.siteScopedRead()({ req: request } as never), false)
        assert.equal(await roles.userMayAccessSite(request, 11), false)
    })

    it('allows the owner to act on their sites from an endpoint', async () => {
        const request = { user: owner, headers: new Headers(), payload: sites }
        assert.equal(await roles.userMayAccessSite(request, 11), true)
        assert.equal(await roles.userMayAccessSite(request, 99), false)
    })
})
