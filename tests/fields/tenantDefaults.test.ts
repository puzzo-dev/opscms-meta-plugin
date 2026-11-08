import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    defaultOrganizationId,
    defaultSiteId,
    pinnedOrganizationValue,
    pinnedSiteValue,
} from '../../src/fields/tenantDefaults.js'

const editor = { id: 3, role: 'editor', site: 7, organization: 2 }
const admin = { id: 2, role: 'admin', organization: { id: 2 } }
const superAdmin = { id: 1, role: 'super-admin' }

describe('meta tenant defaults', () => {
    it('starts an editor on their own site and organization', () => {
        assert.equal(defaultSiteId(editor), 7)
        assert.equal(defaultOrganizationId(editor), 2)
    })

    it('starts an organization admin on their organization and leaves the site open', () => {
        assert.equal(defaultSiteId(admin), null)
        assert.equal(defaultOrganizationId(admin), 2)
    })

    it('does not pick a site or organization for a super-admin', () => {
        assert.equal(defaultSiteId(superAdmin), null)
        assert.equal(defaultOrganizationId(superAdmin), null)
    })

    it('keeps an editor on their site even if the form names another', () => {
        assert.equal(pinnedSiteValue(editor, 99), 7)
        assert.equal(pinnedOrganizationValue(editor, 99, 4), 2)
    })

    it('lets a super-admin keep the site they chose and takes that site\'s organization', () => {
        assert.equal(pinnedSiteValue(superAdmin, 12), 12)
        assert.equal(pinnedOrganizationValue(superAdmin, null, 4), 4)
    })
})
