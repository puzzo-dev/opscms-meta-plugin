import type { CollectionConfig, CollectionAfterChangeHook, FieldAccess } from 'payload'
import {
    siteScopedCreate, siteScopedDelete, siteScopedRead, siteScopedUpdate
} from '../access/roles';
import { organizationField } from '../fields/organizationField';
import { defaultOrganizationId, defaultSiteId, pinnedOrganizationValue, pinnedSiteValue } from '../fields/tenantDefaults';
import { encryptCredential, decryptCredential } from '../utils/metaCrypto';
import { getUserOrgId, getUserWithRole, asCollectionSlug } from '../types';

/**
 * Field-level guard: only admins/super-admins (or trusted server calls using
 * overrideAccess) may set the Meta App Secret / Access Token. Editors can still
 * see the (masked) config, but must not be able to rotate credentials or exfiltrate
 * them by pointing the connection at something else — same reasoning as
 * opscms-erpnext-plugin's adminOrAboveField.
 */
const adminOrAboveField: FieldAccess = ({ req }) =>
    ['super-admin', 'admin'].includes(getUserWithRole(req?.user)?.role ?? '')

// ── Credential encryption hooks (reused by accessToken, oauthUserAccessToken, threadsAccessToken) ──

async function encryptBeforeChange({ value, originalDoc, field, req }: { value: unknown; originalDoc?: Record<string, unknown>; field: { name: string }, req: any }) {
    if (typeof value === 'string' && value && !value.startsWith('••••')) {
        return encryptCredential(value)
    }
    if (typeof value === 'string' && value.startsWith('••••')) {
        // `previousDoc` is only ever populated in afterChange hooks — Payload's
        // own beforeChange field-hook invocation never passes it, only
        // `originalDoc`. Using previousDoc here meant this recovery path threw
        // unconditionally on every resave of a document with an already-encrypted
        // field the admin didn't touch.
        if (!originalDoc?.id) {
            throw new Error(`Cannot save masked credential for ${field.name}. Please re-enter it.`)
        }
        const rawConfig = await req.payload.findByID({
            collection: asCollectionSlug('meta-config'),
            id: originalDoc.id,
            depth: 0,
            overrideAccess: true,
            context: { preventMasking: true, skipConnectionTest: true },
        }) as Record<string, unknown>;

        const decrypted = rawConfig[field.name];
        return decrypted && typeof decrypted === 'string' ? encryptCredential(decrypted) : value;
    }
    return value
}

function decryptAfterRead({ value, req, context }: { value: unknown; req: any; context?: Record<string, unknown> }) {
    if (typeof value !== 'string') return value
    const decrypted = decryptCredential(value)
    const ctx = req?.context || context || {}
    if (ctx.preventMasking) return decrypted
    if (req?.user && decrypted.length > 4) {
        return '••••' + decrypted.slice(-4)
    }
    return decrypted
}

// ── afterChange: test the connection when an access token is saved ──
//
// Meta doesn't have an ERPNext-style "list of companies" to fetch — the closest
// equivalent (enumerating Pages/Pixels/WhatsApp numbers reachable by this token)
// belongs to the OAuth "Connect to Meta Business" flow (see docs/future-features.md,
// not yet built). For now this hook does the minimum useful thing: verifies the
// stored access token is actually valid by calling Graph API's /me, and records
// connectionStatus — same UX shape as ERPNextConfig's auto-fetch, smaller scope.
const testMetaConnection: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
    if (operation === 'update' && previousDoc) {
        const alreadyConnected = doc.connectionStatus === 'connected'
        if (alreadyConnected) return doc
    }

    const rawConfig = await req.payload.findByID({
        collection: asCollectionSlug('meta-config'),
        id: doc.id,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true, skipConnectionTest: true },
    }) as Record<string, unknown>

    const accessToken = rawConfig.accessToken as string | undefined
    if (!accessToken) return doc

    const decryptedToken = decryptCredential(accessToken)
    if (!decryptedToken) return doc

    let connected = false
    try {
        const res = await fetch(
            `https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(decryptedToken)}`,
            { method: 'GET', signal: AbortSignal.timeout(15000) },
        )
        connected = res.ok

        await req.payload.update({
            collection: asCollectionSlug('meta-config'),
            id: doc.id,
            data: { connectionStatus: connected ? 'connected' : 'disconnected' },
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })

        req.payload.logger.info(`[MetaConfig] Connection test ${connected ? 'succeeded' : 'failed'} for config ${doc.id}`)
    } catch (err) {
        req.payload.logger.warn(`[MetaConfig] Connection test failed: ${err}`)
        try {
            await req.payload.update({
                collection: asCollectionSlug('meta-config'),
                id: doc.id,
                data: { connectionStatus: 'disconnected' },
                overrideAccess: true,
                context: { skipConnectionTest: true },
            })
        } catch { /* non-critical */ }
    }

    return doc
}

/**
 * MetaConfig
 *
 * Per-site Meta (Facebook/Instagram/WhatsApp) connection configuration.
 * Modular: a site enables only the channels it needs via the checkboxes on
 * each tab — nothing here assumes every site wants Pixel + Catalog + WhatsApp.
 *
 * UX Flow — one platform Meta App, then each site owner logs in:
 *   META_APP_ID and META_APP_SECRET are set once for the deployment. A site
 *   owner clicks Log in with Facebook, which opens Meta's login popup. The
 *   login writes the Page, Instagram account, catalog, Pixel, and WhatsApp
 *   number onto this document. Those fields stay read-only. Disconnect is
 *   the only way to change them, and it deletes the saved tokens and ids so
 *   the owner can log in again. Threads stays its own login on the Threads tab.
 *
 * Deliberately does NOT yet include: WhatsApp webhook verify-token handling
 * (belongs on the host CMS's existing generic Webhooks collection, not
 * duplicated here — see README.md). See payload-cms/docs/future-features.md
 * for status.
 */
export const MetaConfig: CollectionConfig = {
    slug: 'meta-config',
    labels: { singular: 'Meta Config', plural: 'Meta Configs' },
    admin: {
        useAsTitle: 'label',
        defaultColumns: ['label', 'site', 'connectionStatus', 'isActive', 'updatedAt'],
        group: 'Integrations',
        description: 'Connect this site to Meta (Facebook/Instagram/WhatsApp). Enable only the channels this site needs.',
    },
    access: {
        read: siteScopedRead(),
        create: siteScopedCreate(),
        update: siteScopedUpdate(),
        delete: siteScopedDelete(),
    },
    hooks: {
        afterChange: [
            (args) => {
                if ((args.context as Record<string, unknown>)?.skipConnectionTest) return args.doc

                const payload = args.req.payload
                const docRef = args.doc
                // Fire-and-forget, same 2s-after-commit pattern as ERPNextConfig — avoids
                // racing the save transaction with the immediate findByID re-read.
                setTimeout(() => {
                    testMetaConnection({ ...args, doc: docRef }).catch((err: unknown) => {
                        payload.logger.error(`[MetaConfig] Background connection test failed: ${err}`)
                    })
                }, 2000)

                return args.doc
            },
        ],
    },
    fields: [
        {
            name: 'label',
            type: 'text',
            required: true,
            admin: { description: 'Friendly name, e.g. "That Ofada Girl — Meta"' },
        },
        organizationField({
            defaultValue: ({ user }) => defaultOrganizationId(user) ?? undefined,
            admin: {
                description: 'Choose the organization first. The site list below only includes sites that belong to it.',
            },
            hooks: {
                beforeValidate: [async ({ req, value, siblingData }) => {
                    const account = getUserWithRole(req.user)
                    if (account && account.role !== 'super-admin' && getUserOrgId(account) != null) {
                        return pinnedOrganizationValue(req.user, value, null)
                    }
                    const siteRef = (siblingData as { site?: unknown } | undefined)?.site
                    const siteId = siteRef && typeof siteRef === 'object'
                        ? (siteRef as { id?: string | number }).id
                        : siteRef
                    if (typeof siteId !== 'string' && typeof siteId !== 'number') {
                        return pinnedOrganizationValue(req.user, value, null)
                    }
                    try {
                        const site = await req.payload.findByID({
                            collection: asCollectionSlug('sites'),
                            id: siteId,
                            depth: 0,
                            overrideAccess: true,
                        }) as { organization?: unknown }
                        const orgRef = site?.organization
                        const orgId = orgRef && typeof orgRef === 'object'
                            ? (orgRef as { id?: string | number }).id
                            : orgRef
                        const resolved = typeof orgId === 'string' || typeof orgId === 'number' ? orgId : null
                        return pinnedOrganizationValue(req.user, value, resolved)
                    } catch {
                        return pinnedOrganizationValue(req.user, value, null)
                    }
                }],
            },
        }),
        {
            type: 'row',
            fields: [
                {
                    name: 'site',
                    type: 'relationship',
                    relationTo: 'sites',
                    required: true,
                    defaultValue: ({ user }) => defaultSiteId(user) ?? undefined,
                    filterOptions: ({ data }) => {
                        const orgRef = (data as { organization?: unknown } | undefined)?.organization
                        const orgId = orgRef && typeof orgRef === 'object'
                            ? (orgRef as { id?: string | number }).id
                            : orgRef
                        if (typeof orgId !== 'string' && typeof orgId !== 'number') return false
                        return { organization: { equals: orgId } }
                    },
                    hooks: {
                        beforeValidate: [({ req, value }) => pinnedSiteValue(req.user, value)],
                    },
                    admin: {
                        description: 'A site in the organization above. Filled from your account when you have one site.',
                        width: '70%',
                    },
                },
                {
                    name: 'isActive',
                    type: 'checkbox',
                    defaultValue: true,
                    admin: { width: '30%' },
                },
            ],
        },
        {
            name: 'metaTenantDefaults',
            type: 'ui',
            admin: {
                components: {
                    Field: {
                        path: 'opscms-meta-plugin/components/MetaConnectPanel',
                        exportName: 'MetaTenantDefaults',
                    },
                },
            },
        },

        {
            type: 'tabs',
            tabs: [
                // ── Tab 1: Connection ────────────────────────────────
                {
                    label: '🔑 Connection',
                    description: 'META_APP_ID and META_APP_SECRET are set for the whole deployment. Log in with Facebook below. The fields fill in from that login and stay read-only. Disconnect clears them.',
                    fields: [
                        {
                            name: 'accessToken',
                            type: 'text',
                            // Deliberately optional, not just conditionally required. authMethod
                            // is read-only and only ever flips to 'oauth' *after* a successful
                            // Connect to Meta Business flow — which itself requires this document
                            // to already have an id (the Connect button only renders once saved).
                            // Gating this field's requirement on authMethod === 'oauth' therefore
                            // made the very first save of a brand-new OAuth-only config impossible:
                            // authMethod could never be 'oauth' yet, so accessToken was always
                            // required, so the document could never be saved, so Connect could
                            // never appear. getMetaCredentials() (utils/metaCredentials.ts) already
                            // fails closed with a clear error at USE time if neither a manual token
                            // nor a completed OAuth connection exist, so nothing needs to be
                            // enforced here at save time.
                            access: { create: adminOrAboveField, update: adminOrAboveField },
                            admin: {
                                description: 'Filled by Facebook login. Shown masked. Disconnect clears it.',
                                readOnly: true,
                            },
                            hooks: {
                                beforeChange: [
                                    async ({ value, originalDoc, req }) =>
                                        await encryptBeforeChange({ value, originalDoc, field: { name: 'accessToken' }, req }),
                                ],
                                afterRead: [
                                    ({ value, req, context }) =>
                                        decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                ],
                            },
                        },
                        {
                            name: 'businessManagerId',
                            type: 'text',
                            admin: {
                                description: 'Filled by Facebook login.',
                                readOnly: true,
                            },
                        },
                        {
                            name: 'connectionStatus',
                            type: 'select',
                            defaultValue: 'untested',
                            options: [
                                { label: '✅ Connected', value: 'connected' },
                                { label: '❌ Disconnected', value: 'disconnected' },
                                { label: '⏳ Untested', value: 'untested' },
                            ],
                            admin: {
                                description: 'Connection health — updated automatically when you save.',
                                readOnly: true,
                            },
                        },
                        {
                            name: 'authMethod',
                            type: 'select',
                            defaultValue: 'manual',
                            options: [
                                { label: 'Manual (paste Access Token)', value: 'manual' },
                                { label: 'Connected via Meta Business Login', value: 'oauth' },
                            ],
                            admin: {
                                description: 'Set automatically by the Connect flow below — informational only, does not change how credentials are used.',
                                readOnly: true,
                            },
                        },
                        {
                            name: 'metaConnectPanel',
                            type: 'ui',
                            admin: {
                                components: {
                                    Field: {
                                        path: 'opscms-meta-plugin/components/MetaConnectPanel',
                                        exportName: 'MetaConnectPanelField',
                                    },
                                },
                            },
                        },
                        {
                            type: 'row',
                            fields: [
                                {
                                    name: 'facebookPageId',
                                    type: 'text',
                                    admin: { description: 'Set by Connect. Facebook Page ID.', readOnly: true, width: '50%' },
                                },
                                {
                                    name: 'facebookPageName',
                                    type: 'text',
                                    admin: { description: 'Set by Connect.', readOnly: true, width: '50%' },
                                },
                            ],
                        },
                        {
                            type: 'row',
                            fields: [
                                {
                                    name: 'instagramBusinessAccountId',
                                    type: 'text',
                                    admin: { description: 'Set by Connect — auto-detected from the selected Page.', readOnly: true, width: '50%' },
                                },
                                {
                                    name: 'instagramUsername',
                                    type: 'text',
                                    admin: { description: 'Set by Connect.', readOnly: true, width: '50%' },
                                },
                            ],
                        },
                        {
                            name: 'oauthUserAccessToken',
                            type: 'text',
                            admin: {
                                hidden: true,
                                description: 'Internal — long-lived user token from Meta Business Login, used to re-fetch Pages/Pixels. Not the credential used for API calls (accessToken, set to the selected Page\'s token, is).',
                            },
                            hooks: {
                                beforeChange: [
                                    async ({ value, originalDoc, req }) =>
                                        await encryptBeforeChange({ value, originalDoc, field: { name: 'oauthUserAccessToken' }, req }),
                                ],
                                afterRead: [
                                    ({ value, req, context }) =>
                                        decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                ],
                            },
                        },
                        {
                            name: 'oauthExpiresAt',
                            type: 'date',
                            admin: {
                                hidden: true,
                                description: 'Internal — when the long-lived Page access token (accessToken) expires (~60 days from Connect). getMetaCredentials() fails closed and marks the connection disconnected past this point; Meta has no refresh_token grant, so re-connecting is currently a manual action.',
                            },
                        },
                    ],
                },

                // ── Tab 2: Pixel & Conversions API ───────────────────
                {
                    label: '📊 Pixel & Conversions API',
                    description: 'Client-side Pixel events plus a matching server-side Conversions API event (deduplicated by event_id) for accurate tracking despite iOS ad-tracking loss.',
                    fields: [
                        {
                            name: 'pixelEnabled',
                            type: 'checkbox',
                            defaultValue: false,
                            admin: {
                                description: 'Turned on when Facebook login saves a Pixel. Disconnect turns it off.',
                                readOnly: true,
                            },
                        },
                        {
                            name: 'pixelId',
                            type: 'text',
                            admin: {
                                description: 'Filled by Facebook login.',
                                readOnly: true,
                                condition: (_data, siblingData) => Boolean(siblingData?.pixelEnabled),
                            },
                        },
                        {
                            name: 'metaPixelSelectPanel',
                            type: 'ui',
                            admin: {
                                condition: (data) => Boolean(data?.pixelEnabled) && data?.authMethod !== 'oauth',
                                components: {
                                    Field: {
                                        path: 'opscms-meta-plugin/components/MetaPixelSelect',
                                        exportName: 'MetaPixelSelectField',
                                    },
                                },
                            },
                        },
                    ],
                },

                // ── Tab 3: Commerce Catalog ──────────────────────────
                {
                    label: '🛍️ Commerce Catalog',
                    description: 'Sends this site\'s commerce catalogue to the Facebook catalog owned by the Facebook account that connected the site. Saving a catalogue item updates Meta. The public CSV feed stays available for Commerce Manager to fetch as well.',
                    fields: [
                        {
                            name: 'catalogEnabled',
                            type: 'checkbox',
                            defaultValue: false,
                            admin: {
                                description: 'Turned on when Facebook login saves a catalog. Disconnect turns it off.',
                                readOnly: true,
                            },
                        },
                        {
                            name: 'catalogId',
                            type: 'text',
                            admin: {
                                description: 'Filled by Facebook login.',
                                readOnly: true,
                                condition: (_data, siblingData) => Boolean(siblingData?.catalogEnabled),
                            },
                        },
                        {
                            name: 'catalogSourceCollection',
                            type: 'text',
                            defaultValue: 'catalogue-items',
                            admin: {
                                description: 'Leave this as catalogue-items for the commerce plugin. That is the collection whose products sync to Meta.',
                                condition: (_data, siblingData) => Boolean(siblingData?.catalogEnabled),
                            },
                        },
                        {
                            name: 'catalogItemUrlTemplate',
                            type: 'text',
                            admin: {
                                description: 'Item page URL template on the live site — "{slug}" is replaced per item, e.g. https://thatofadagirl.com/menu/{slug}. Required before products can sync (Meta rejects an item with no link).',
                                condition: (_data, siblingData) => Boolean(siblingData?.catalogEnabled),
                            },
                        },
                        {
                            name: 'metaCatalogSyncPanel',
                            type: 'ui',
                            admin: {
                                components: {
                                    Field: {
                                        path: 'opscms-meta-plugin/components/MetaCatalogSync',
                                        exportName: 'MetaCatalogSyncField',
                                    },
                                },
                            },
                        },
                    ],
                },

                // ── Tab 4: WhatsApp Business ─────────────────────────
                {
                    label: '💬 WhatsApp Business',
                    description: 'Official WhatsApp for this site. Choose the number in the connect flow after Facebook login. Alert messages are prepared for you, and Meta reviews them — you can leave the page while that happens. Leave this off to keep the OpenWA bridge.',
                    fields: [
                        {
                            name: 'whatsappEnabled',
                            type: 'checkbox',
                            defaultValue: false,
                            admin: {
                                description: 'Turned on when Facebook login saves a WhatsApp number. Disconnect turns it off and the OpenWA bridge is used again.',
                                readOnly: true,
                            },
                        },
                        {
                            name: 'whatsappPhoneNumberId',
                            type: 'text',
                            admin: {
                                description: 'Filled by Facebook login.',
                                readOnly: true,
                                condition: (_data, siblingData) => Boolean(siblingData?.whatsappEnabled),
                            },
                        },
                        {
                            name: 'whatsappBusinessAccountId',
                            type: 'text',
                            admin: {
                                description: 'Filled by Facebook login.',
                                readOnly: true,
                                condition: (_data, siblingData) => Boolean(siblingData?.whatsappEnabled),
                            },
                        },
                    ],
                },

                // ── Tab 5: Threads ────────────────────────────────────
                {
                    label: '🧵 Threads',
                    description: 'Threads is a separate product/API from Facebook & Instagram (its own OAuth flow, on the same Meta App) — connect it independently.',
                    fields: [
                        {
                            name: 'threadsEnabled',
                            type: 'checkbox',
                            defaultValue: false,
                            admin: { description: 'Enable Threads for this site — set automatically once Connect Threads succeeds; can also be toggled off to disable without disconnecting.' },
                        },
                        {
                            name: 'threadsConnectPanel',
                            type: 'ui',
                            admin: {
                                components: {
                                    Field: {
                                        path: 'opscms-meta-plugin/components/ThreadsConnectPanel',
                                        exportName: 'ThreadsConnectPanelField',
                                    },
                                },
                            },
                        },
                        {
                            type: 'row',
                            fields: [
                                {
                                    name: 'threadsUserId',
                                    type: 'text',
                                    admin: { description: 'Set by Connect Threads.', readOnly: true, width: '50%' },
                                },
                                {
                                    name: 'threadsUsername',
                                    type: 'text',
                                    admin: { description: 'Set by Connect Threads.', readOnly: true, width: '50%' },
                                },
                            ],
                        },
                        {
                            name: 'threadsAccessToken',
                            type: 'text',
                            admin: {
                                hidden: true,
                                description: 'Internal — long-lived Threads access token.',
                            },
                            hooks: {
                                beforeChange: [
                                    async ({ value, originalDoc, req }) =>
                                        await encryptBeforeChange({ value, originalDoc, field: { name: 'threadsAccessToken' }, req }),
                                ],
                                afterRead: [
                                    ({ value, req, context }) =>
                                        decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                ],
                            },
                        },
                        {
                            name: 'threadsTokenExpiresAt',
                            type: 'date',
                            admin: {
                                hidden: true,
                                description: 'Internal — when threadsAccessToken expires (~60 days from Connect Threads).',
                            },
                        },
                    ],
                },
            ],
        },
    ],
    timestamps: true,
}
