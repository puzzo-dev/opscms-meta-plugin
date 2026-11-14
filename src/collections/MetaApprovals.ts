import type { CollectionConfig } from 'payload'

import { siteScopedDelete, siteScopedRead } from '../access/roles'

/**
 * Meta's approval of a notification template, for one site.
 *
 * A template is just a template: the message text SMS and WhatsApp both send (only email carries formatting and pictures).
 * When a site sends it by WhatsApp through Meta, Meta must approve that exact wording first, and Meta approves it per business
 * account. This is the plugin's record of that, one row per site, template and wording: it is bookkeeping, not something the
 * owner works with. The owner sees the outcome on the template itself (the "WhatsApp delivery" line).
 */
export const MetaApprovals: CollectionConfig = {
    slug: 'meta-approvals',
    labels: { singular: 'Meta Approval', plural: 'Meta Approvals' },
    admin: {
        useAsTitle: 'templateKey',
        defaultColumns: ['templateKey', 'site', 'status', 'rejectionReason', 'updatedAt'],
        group: 'Meta Business Suite',
        // Internal bookkeeping. The status shows on the notification template.
        hidden: true,
    },
    access: {
        read: siteScopedRead(),
        create: () => false,
        update: () => false,
        delete: siteScopedDelete(),
    },
    indexes: [{ fields: ['site', 'templateKey', 'contentHash'], unique: true }],
    fields: [
        { name: 'site', type: 'relationship', relationTo: 'sites', required: true, index: true, admin: { readOnly: true } },
        { name: 'templateKey', type: 'text', required: true, index: true, admin: { readOnly: true, description: 'The notification template this was made from.' } },
        { name: 'contentHash', type: 'text', required: true, admin: { readOnly: true, description: 'A fingerprint of the wording that was submitted.' } },
        { name: 'metaName', type: 'text', required: true, admin: { readOnly: true, description: 'The name Meta knows the template by.' } },
        { name: 'language', type: 'text', required: true, admin: { readOnly: true } },
        { name: 'category', type: 'text', admin: { readOnly: true, description: 'As Meta classified it.' } },
        {
            name: 'status',
            type: 'select',
            required: true,
            defaultValue: 'pending',
            index: true,
            options: [
                { label: 'With Meta for review', value: 'pending' },
                { label: 'Approved', value: 'approved' },
                { label: 'Rejected by Meta', value: 'rejected' },
                { label: 'Paused by Meta', value: 'paused' },
                { label: 'Disabled by Meta', value: 'disabled' },
                { label: 'Wording Meta would refuse', value: 'invalid' },
                { label: 'Could not be submitted', value: 'failed' },
            ],
            admin: { readOnly: true },
        },
        { name: 'metaTemplateId', type: 'text', index: true, admin: { readOnly: true, description: 'Meta\'s id for the template, once submitted.' } },
        { name: 'wabaId', type: 'text', admin: { readOnly: true, description: 'The WhatsApp business account it was submitted to.' } },
        { name: 'rejectionReason', type: 'textarea', admin: { readOnly: true, description: 'Why it is not approved, in plain words.' } },
        { name: 'body', type: 'textarea', admin: { readOnly: true, description: 'The wording as submitted to Meta.' } },
        { name: 'parameters', type: 'json', admin: { readOnly: true, description: 'Which workflow data fills each placeholder.' } },
        { name: 'alertedStatus', type: 'text', admin: { readOnly: true, hidden: true, description: 'The last problem the owner was told about, so it is told once.' } },
    ],
    timestamps: true,
}
