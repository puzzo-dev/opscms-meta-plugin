import type { Plugin, Field, BlocksField, CollectionConfig } from 'payload'
import { MetaConfig } from './collections/MetaConfig'
import { metaCatalogFeedEndpoint } from './endpoints/metaCatalogFeed'
import { metaConversionEventHandler } from './actions/metaActions'
import {
    metaOAuthAppInfoEndpoint,
    metaOAuthStartEndpoint,
    metaOAuthCallbackEndpoint,
    metaOAuthDisconnectEndpoint,
    metaOAuthPagesEndpoint,
    metaOAuthSelectPageEndpoint,
    metaOAuthListPixelsEndpoint,
    metaOAuthSelectPixelEndpoint,
    metaOAuthCreatePixelEndpoint,
} from './endpoints/metaOAuth'
import { threadsOAuthStartEndpoint, threadsOAuthCallbackEndpoint } from './endpoints/threadsOAuth'
import {
    metaOAuthMeEndpoint,
    metaCatalogListEndpoint,
    metaCatalogSelectEndpoint,
    metaCatalogCreateEndpoint,
    metaCatalogSyncEndpoint,
} from './endpoints/metaCatalogSync'
import {
    metaWhatsAppNumbersEndpoint,
    createMetaWhatsAppSelectEndpoint,
} from './endpoints/metaWhatsApp'
import { COMMERCE_COLLECTION } from './sync/catalogProduct'
import { syncCatalogDoc } from './sync/catalogSync'
import { metaWhatsAppChannel } from './channels/whatsapp'
import { createMetaWebhookEndpoints } from './endpoints/metaWebhook'
import { createMetaLoginEndpoints } from './endpoints/metaLogin'
import { attachFacebookLogin } from './fields/facebookIdField'
import { MetaApprovals } from './collections/MetaApprovals'
import { createTemplateStatusJob } from './jobs/templateStatus'
import { attachTemplateHooks } from './templates/hooks'
import type { MetaHost } from './types/host'
import { registerNotificationChannel } from './channels/registry'

/** Minimal interface for the CMS action registry — same shape payload-erpnext-plugin uses. */
export interface ActionRegistryRef {
    register: (slug: string, handler: (ctx: any) => Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>) => void
}

export interface MetaPluginOptions {
    /**
     * CMS action registry — pass `actionRegistry` from `payload-cms/src/lib/actionRegistry`.
     * When provided, the plugin registers `meta-conversion-event` so it can be
     * invoked by the workflow engine's "Trigger Meta Conversion Event" step.
     */
    registry?: ActionRegistryRef
    /**
     * The host CMS's workflow engine. With it, what Meta reports to the plugin's webhook (a template approved, rejected or
     * recategorised) is handed to the host as an event for its workflows to act on. Without it the webhook still checks and
     * accepts Meta's deliveries, but nobody is told.
     */
    host?: MetaHost
}

/**
 * Meta Network Plugin for Payload CMS
 *
 * Lets an admin/superadmin connect any site in the multi-tenant platform to
 * Meta's network. Modular per-channel (Pixel/Conversions API, Commerce Catalog,
 * WhatsApp Business Cloud API) and per-site — a site enables only what it needs.
 *
 * Provides:
 *  - `meta-config` collection — per-site connection + per-channel config,
 *    credentials encrypted at rest, Graph API connection-health check.
 *  - "Connect to Meta Business" OAuth flow (same UX as the official Meta for
 *    WordPress plugin): authorize, pick a Facebook Page you manage, its linked
 *    Instagram Business account is auto-detected, then select or create a
 *    Pixel — plus a separate Threads connect flow. Manual credential entry
 *    stays fully available side by side; OAuth just populates the same
 *    fields.
 *  - Server-side Conversions API dispatch (`sendConversionEvent`), wired into
 *    the CMS workflow engine as a `meta-conversion-event` action (requires
 *    `registry`) so any Workflow can fire a "Trigger Meta Conversion Event"
 *    step — order creation → Purchase, contact-form submit → Lead, etc.
 *  - `GET /api/meta-catalog/feed?site=<slug>` — Commerce Catalog CSV feed,
 *    generated from whichever collection the site's meta-config designates.
 *
 * Deliberately does not yet include the WhatsApp webhook verify-token
 * handshake — that belongs on the host CMS's existing generic `webhooks`
 * collection + `webhookReceiver.ts`, not duplicated here. See
 * payload-cms/docs/future-features.md and this package's README.md.
 */
export function metaPlugin(options: MetaPluginOptions = {}): Plugin {
    if (options.registry) {
        options.registry.register('meta-conversion-event', metaConversionEventHandler)
    }

    return (config) => {
        // Sites that connected a WhatsApp number on their Facebook login send the host's notifications from it.
        registerNotificationChannel(metaWhatsAppChannel)

        // The collection people sign in to gets the Facebook link, and the login page a "Continue with Facebook" button.
        const usersSlug = (config.admin?.user as string | undefined) ?? 'users'
        const modifiedCollections = (config.collections || []).map((collection) => {
            const withSync = attachFacebookLogin(attachTemplateHooks(attachCommerceCatalogSync(collection), options.host), usersSlug)
            if (withSync.slug !== 'workflows') return withSync

            const stepsField = withSync.fields.find((f: Field): f is BlocksField => 'name' in f && f.name === 'steps' && f.type === 'blocks')
            if (!stepsField) return withSync

            stepsField.blocks = [
                ...(stepsField.blocks || []),
                {
                    slug: 'trigger_meta_conversion',
                    labels: { singular: 'Trigger Meta Conversion Event', plural: 'Trigger Meta Conversion Events' },
                    fields: [
                        {
                            name: 'event_name',
                            type: 'select',
                            required: true,
                            options: [
                                { label: 'Lead', value: 'Lead' },
                                { label: 'Purchase', value: 'Purchase' },
                                { label: 'AddToCart', value: 'AddToCart' },
                                { label: 'InitiateCheckout', value: 'InitiateCheckout' },
                                { label: 'ViewContent', value: 'ViewContent' },
                                { label: 'CompleteRegistration', value: 'CompleteRegistration' },
                            ],
                            admin: { description: 'Meta standard event name.' },
                        },
                        {
                            name: 'value',
                            type: 'text',
                            admin: { description: 'Numeric value, e.g. order total. Supports {{var}} (e.g. {{order_total}}).' },
                        },
                        {
                            name: 'currency',
                            type: 'text',
                            defaultValue: 'NGN',
                            admin: { description: '3-letter currency code. Supports {{var}}.' },
                        },
                        {
                            name: 'content_name',
                            type: 'text',
                            admin: { description: 'Optional. Supports {{var}}.' },
                        },
                        {
                            name: 'event_source_url',
                            type: 'text',
                            admin: { description: 'Optional. Supports {{var}}.' },
                        },
                        {
                            type: 'row',
                            fields: [
                                {
                                    name: 'email',
                                    type: 'text',
                                    admin: { description: 'Optional, e.g. {{doc.email}}. SHA-256 hashed before sending — improves Meta\'s event match quality, raw value never leaves the server.', width: '50%' },
                                },
                                {
                                    name: 'phone',
                                    type: 'text',
                                    admin: { description: 'Optional, e.g. {{doc.phone}}. SHA-256 hashed before sending.', width: '50%' },
                                },
                            ],
                        },
                    ],
                },
            ]
            return withSync
        })

        return {
            ...config,
            admin: {
                ...config.admin,
                components: {
                    ...config.admin?.components,
                    afterLogin: [
                        ...(config.admin?.components?.afterLogin ?? []),
                        { path: 'payload-meta-plugin/components/MetaLoginButton', exportName: 'MetaLoginButton' },
                    ],
                },
            },
            jobs: { ...config.jobs, tasks: [...(config.jobs?.tasks ?? []), createTemplateStatusJob(options.host)] },
            collections: [...modifiedCollections, MetaConfig, MetaApprovals],
            endpoints: [
                ...(config.endpoints || []),
                metaCatalogFeedEndpoint,
                metaOAuthAppInfoEndpoint,
                metaOAuthStartEndpoint,
                metaOAuthCallbackEndpoint,
                metaOAuthDisconnectEndpoint,
                metaOAuthPagesEndpoint,
                metaOAuthSelectPageEndpoint,
                metaOAuthListPixelsEndpoint,
                metaOAuthSelectPixelEndpoint,
                metaOAuthCreatePixelEndpoint,
                metaOAuthMeEndpoint,
                metaCatalogListEndpoint,
                metaCatalogSelectEndpoint,
                metaCatalogCreateEndpoint,
                metaCatalogSyncEndpoint,
                metaWhatsAppNumbersEndpoint,
                createMetaWhatsAppSelectEndpoint(options.host),
                threadsOAuthStartEndpoint,
                threadsOAuthCallbackEndpoint,
                ...createMetaWebhookEndpoints(options.host),
                ...createMetaLoginEndpoints(options.host),
            ],
        }
    }
}

function attachCommerceCatalogSync(collection: CollectionConfig): CollectionConfig {
    if (collection.slug !== COMMERCE_COLLECTION) return collection
    const slug = collection.slug
    return {
        ...collection,
        hooks: {
            ...collection.hooks,
            afterChange: [
                ...(collection.hooks?.afterChange || []),
                async ({ doc, req }) => {
                    if (req.context?.skipMetaCatalogSync) return doc
                    if ((doc as { _status?: string })._status === 'draft') return doc
                    try {
                        await syncCatalogDoc(req.payload, doc as Record<string, unknown>, 'UPDATE', slug)
                    } catch (err) {
                        req.payload.logger.warn(`[MetaCatalog] save sync failed: ${err}`)
                    }
                    return doc
                },
            ],
            afterDelete: [
                ...(collection.hooks?.afterDelete || []),
                async ({ doc, req }) => {
                    if (!doc) return
                    try {
                        await syncCatalogDoc(req.payload, doc as Record<string, unknown>, 'DELETE', slug)
                    } catch (err) {
                        req.payload.logger.warn(`[MetaCatalog] delete sync failed: ${err}`)
                    }
                },
            ],
        },
    }
}

export { explainTemplateSendError } from './whatsapp/templateErrors'
export { encryptCredential, decryptCredential } from './utils/metaCrypto'
export { getMetaCredentials } from './utils/metaCredentials'
export { sendConversionEvent } from './sync/conversionsApi'
export { metaConversionEventHandler } from './actions/metaActions'
export type { ConversionEventInput, ConversionEventResult } from './sync/conversionsApi'
export type { MetaCredentials, MetaConfigDoc } from './types'

export { metaWhatsAppChannel } from './channels/whatsapp'
export type { NotificationChannelProvider } from './channels/types'
export type { MetaHost, HostEventOutcome } from './types/host'
export { createMetaWebhookEndpoints } from './endpoints/metaWebhook'
export { createMetaLoginEndpoints } from './endpoints/metaLogin'
export { facebookIdField, attachFacebookLogin } from './fields/facebookIdField'
export { resolveLoginUser } from './login/resolveUser'
export type { FacebookLoginFailure, FacebookProfile } from './types/login'
export { subscribeWabaToApp, unsubscribeWabaFromApp } from './utils/wabaSubscription'
