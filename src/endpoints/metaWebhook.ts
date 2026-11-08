import type { Endpoint } from 'payload'

import { asCollectionSlug } from '../types'
import type { MetaHost } from '../types/host'
import { getMetaAppCredentials } from '../utils/metaCrypto'
import { statusFromMeta } from '../templates/graph'
import { applyStatusChange, findRecordForReport } from '../templates/sync'
import { handshakeChallenge, signatureMatches } from '../webhook/signature'
import { templateEventsFrom } from '../webhook/templateEvents'

/**
 * The plugin's webhook: the address Meta calls to report what happens on its side.
 *
 * Register `https://<your CMS>/api/meta-webhook` as the callback of the platform's Meta app, for the WhatsApp business account
 * topic, with the verify token set in `META_WEBHOOK_VERIFY_TOKEN`. Each site's business account is subscribed to the app when
 * the site connects (see utils/wabaSubscription.ts), so its events arrive here.
 *
 *  - GET answers Meta's handshake.
 *  - POST checks the signature (HMAC of the raw body under the app secret), reads the template changes, finds the sites that
 *    connected that business account, and tells the host about each one. The workflow that turns it into a notice to the site's
 *    owner is the host's.
 *
 * A delivery with a bad or missing signature is refused with 401 before its body is parsed. A good one is answered 200 once
 * every event has been handed over; if the host fails, the answer is 500 so Meta sends it again.
 */
export function createMetaWebhookEndpoints(host?: MetaHost): Endpoint[] {
    const handshake: Endpoint = {
        path: '/meta-webhook',
        method: 'get',
        handler: async (req) => {
            const challenge = handshakeChallenge(req.query as Record<string, unknown> | undefined, process.env.META_WEBHOOK_VERIFY_TOKEN)
            if (challenge === null) return Response.json({ error: 'Verification failed' }, { status: 403 })
            // Meta expects the challenge echoed back as the raw body.
            return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } })
        },
    }

    const receive: Endpoint = {
        path: '/meta-webhook',
        method: 'post',
        handler: async (req) => {
            const credentials = getMetaAppCredentials()
            if (!credentials) return Response.json({ error: 'The Meta app is not configured on this server' }, { status: 503 })

            const rawBody = (await req.text?.()) ?? ''
            if (!signatureMatches(rawBody, req.headers?.get('x-hub-signature-256'), credentials.appSecret)) {
                return Response.json({ error: 'Invalid signature' }, { status: 401 })
            }

            let body: unknown
            try {
                body = JSON.parse(rawBody)
            } catch {
                return Response.json({ error: 'Invalid body' }, { status: 400 })
            }

            const events = templateEventsFrom(body)

            // Keep the plugin's own record of each template current, and raise the alert if Meta did not approve it. This does
            // not need the host to be told first, so a lost host call cannot leave a rejected template looking pending.
            for (const event of events) {
                try {
                    const record = await findRecordForReport(req.payload, { templateId: event.data.templateId, templateName: event.data.templateName })
                    if (!record) continue
                    if (event.eventName === 'meta.template.status_changed') {
                        await applyStatusChange({ payload: req.payload, req, host }, record, { status: statusFromMeta(event.data.status), reason: event.data.reason })
                    } else if (event.eventName === 'meta.template.category_changed' && event.data.status) {
                        await applyStatusChange({ payload: req.payload, req, host }, record, { status: record.status, category: event.data.status })
                    }
                } catch (err) {
                    req.payload.logger.error(`[meta:webhook] could not record ${event.eventName}: ${err}`)
                }
            }

            if (events.length === 0 || !host) return Response.json({ ok: true, handled: 0 })

            let failed = 0
            let handled = 0
            for (const event of events) {
                const configs = await req.payload.find({
                    collection: asCollectionSlug('meta-config'),
                    where: { and: [{ whatsappBusinessAccountId: { equals: event.wabaId } }, { isActive: { equals: true } }] } as never,
                    limit: 50,
                    depth: 1,
                    overrideAccess: true,
                })
                for (const config of configs.docs as unknown as Array<{ site?: { slug?: string } | number | null }>) {
                    const slug = typeof config.site === 'object' && config.site ? config.site.slug : undefined
                    if (!slug) continue
                    try {
                        await host.emitSystemEvent(req.payload, event.eventName, { siteSlug: slug, data: event.data }, req)
                        handled += 1
                    } catch (err) {
                        failed += 1
                        req.payload.logger.error(`[meta:webhook] could not hand ${event.eventName} to the host for ${slug}: ${err}`)
                    }
                }
            }
            if (failed > 0) return Response.json({ error: 'Not every event could be handled' }, { status: 500 })
            return Response.json({ ok: true, handled })
        },
    }

    return [handshake, receive]
}
