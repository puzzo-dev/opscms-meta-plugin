import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { CollectionConfig, Field, PayloadRequest } from 'payload'

import { attachTemplateHooks } from '../../src/templates/hooks'

/** The status line on a notification template must show a person only their own sites' approvals. */

const base = { slug: 'notification-templates', fields: [{ name: 'key', type: 'text' }] } as unknown as CollectionConfig
const withLine = attachTemplateHooks(base)
const field = withLine.fields.find((f): f is Field & { name: string } => 'name' in f && f.name === 'whatsappDelivery')

describe('the WhatsApp delivery line on a notification template', () => {
    it('is added to the template, computed and not stored', () => {
        assert.ok(field)
        assert.equal((field as { virtual?: boolean }).virtual, true)
        assert.equal((field as { admin?: { readOnly?: boolean } }).admin?.readOnly, true)
    })

    it('leaves other collections alone', () => {
        const other = { slug: 'pages', fields: [] } as unknown as CollectionConfig
        assert.equal(attachTemplateHooks(other), other)
    })

    const read = async (req: unknown, key = 'order_received') =>
        (field as unknown as { hooks: { afterRead: Array<(a: unknown) => Promise<string>> } }).hooks.afterRead[0]({ req, siblingData: { key } })

    it('reads through the signed-in person\'s own access, never the plugin\'s', async () => {
        let call: Record<string, unknown> = {}
        const user = { id: 5, role: 'admin' }
        const req = {
            user,
            payload: {
                logger: { warn() {} },
                find: async (args: Record<string, unknown>) => {
                    call = args
                    return { docs: [{ status: 'approved', site: { id: 7, name: 'Shop' }, rejectionReason: null }, { status: 'pending', site: { id: 7, name: 'Shop' } }] }
                },
            },
        } as unknown as PayloadRequest
        const line = await read(req)
        assert.equal(call.overrideAccess, false)
        assert.equal(call.user, user)
        assert.equal(line, 'Shop — approved')
    })

    it('shows each site\'s newest status, with the reason when it was not approved', async () => {
        const req = {
            user: { id: 1 },
            payload: {
                logger: { warn() {} },
                find: async () => ({ docs: [
                    { status: 'rejected', rejectionReason: 'INVALID_FORMAT', site: { id: 8, name: 'Other' } },
                    { status: 'approved', site: { id: 7, name: 'Shop' } },
                ] }),
            },
        } as unknown as PayloadRequest
        assert.equal(await read(req), 'Other — rejected by Meta: INVALID_FORMAT\nShop — approved')
    })

    it('shows nothing without a signed-in person, and nothing when the lookup fails', async () => {
        assert.equal(await read({ user: null, payload: { logger: { warn() {} } } }), '')
        const broken = { user: { id: 1 }, payload: { logger: { warn() {} }, find: async () => { throw new Error('db') } } }
        assert.equal(await read(broken), '')
    })
})
