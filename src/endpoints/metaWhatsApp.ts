import type { Endpoint } from 'payload'
import { graphGet } from '../utils/metaGraphClient'
import { callerOwnsConfigSite, asCollectionSlug, getUserWithRole } from '../types'
import { listBusinesses } from '../utils/metaBusinesses'
import { tokenForCatalog } from '../sync/catalogSync'
import { subscribeWabaToApp } from '../utils/wabaSubscription'
import type { MetaHost } from '../types/host'
import { syncAllTemplatesForSite } from '../templates/sync'

export interface WhatsAppNumberOption {
    id: string
    displayPhone: string
    verifiedName: string
    wabaId: string
    wabaName: string
}

interface GraphPhone {
    id?: string
    display_phone_number?: string
    verified_name?: string
}

export function phonesFromWaba(
    waba: { id: string; name?: string },
    phones: GraphPhone[],
): WhatsAppNumberOption[] {
    const options: WhatsAppNumberOption[] = []
    for (const phone of phones) {
        if (!phone.id) continue
        options.push({
            id: phone.id,
            displayPhone: phone.display_phone_number || phone.id,
            verifiedName: phone.verified_name || '',
            wabaId: waba.id,
            wabaName: waba.name || waba.id,
        })
    }
    return options
}

function isAdminOrAbove(req: { user?: unknown }): boolean {
    const role = getUserWithRole(req.user)?.role
    return role === 'super-admin' || role === 'admin' || role === 'editor'
}

async function loadConfig(req: Parameters<Endpoint['handler']>[0], configId: string) {
    return (await req.payload.findByID({
        collection: asCollectionSlug('meta-config'),
        id: configId,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true },
    })) as Record<string, unknown>
}

async function numbersForToken(
    token: string,
    businessManagerId: unknown,
): Promise<{ ok: true; numbers: WhatsAppNumberOption[] } | { ok: false; error: string }> {
    const businesses = await listBusinesses(token, businessManagerId)
    if (!businesses.ok) return businesses

    const numbers: WhatsAppNumberOption[] = []
    const seen = new Set<string>()
    for (const business of businesses.businesses) {
        for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts'] as const) {
            const accounts = await graphGet<{ data?: Array<{ id: string; name?: string }> }>(
                `/${business.id}/${edge}`,
                { fields: 'id,name', access_token: token, limit: '25' },
            )
            if (!accounts.ok) continue
            for (const waba of accounts.data?.data ?? []) {
                const phones = await graphGet<{ data?: GraphPhone[] }>(`/${waba.id}/phone_numbers`, {
                    fields: 'id,display_phone_number,verified_name',
                    access_token: token,
                    limit: '25',
                })
                if (!phones.ok) continue
                for (const option of phonesFromWaba(waba, phones.data?.data ?? [])) {
                    if (seen.has(option.id)) continue
                    seen.add(option.id)
                    numbers.push(option)
                }
            }
        }
    }
    return { ok: true, numbers }
}

// ── GET /meta-whatsapp/numbers?configId= ────────────────────────────────────
export const metaWhatsAppNumbersEndpoint: Endpoint = {
    path: '/meta-whatsapp/numbers',
    method: 'get',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const configId = req.query?.configId as string | undefined
        if (!configId) return Response.json({ error: 'Missing configId' }, { status: 400 })
        const config = await loadConfig(req, configId)
        if (!callerOwnsConfigSite(req, config)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const token = tokenForCatalog(config)
        if (!token) return Response.json({ error: 'Connect this site with Facebook before choosing a WhatsApp number.' }, { status: 400 })
        const listed = await numbersForToken(token, config.businessManagerId)
        if (!listed.ok) return Response.json({ error: listed.error }, { status: 502 })
        return Response.json({ numbers: listed.numbers })
    },
}

// ── POST /meta-whatsapp/select { configId, phoneNumberId } ──────────────────
export const createMetaWhatsAppSelectEndpoint = (host?: MetaHost): Endpoint => ({
    path: '/meta-whatsapp/select',
    method: 'post',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const body = (await req.json?.()) as { configId?: string; phoneNumberId?: string } | undefined
        if (!body?.configId || !body.phoneNumberId) {
            return Response.json({ error: 'Missing configId or phoneNumberId' }, { status: 400 })
        }
        const config = await loadConfig(req, body.configId)
        if (!callerOwnsConfigSite(req, config)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const token = tokenForCatalog(config)
        if (!token) return Response.json({ error: 'Connect this site with Facebook first.' }, { status: 400 })

        const listed = await numbersForToken(token, config.businessManagerId)
        if (!listed.ok) return Response.json({ error: listed.error }, { status: 502 })
        const chosen = listed.numbers.find((number) => number.id === body.phoneNumberId)
        if (!chosen) {
            return Response.json({ error: 'That WhatsApp number is not on this Facebook login.' }, { status: 404 })
        }

        await req.payload.update({
            collection: asCollectionSlug('meta-config'),
            id: body.configId,
            data: {
                whatsappEnabled: true,
                whatsappPhoneNumberId: chosen.id,
                whatsappBusinessAccountId: chosen.wabaId,
            },
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })
        // Meta only reports this business account's events (template approvals, quality, alerts) to an app it has subscribed. A
        // failure does not undo the choice of number; it is reported so the screen can say events will not arrive until retried.
        const subscription = await subscribeWabaToApp(token, chosen.wabaId)
        if (!subscription.ok) req.payload.logger.warn(`[meta:whatsapp] could not subscribe ${chosen.wabaId} to the app: ${subscription.error}`)
        // The site now sends WhatsApp through Meta: submit the templates its workflows already use, so approval starts now rather
        // than the next time someone saves a workflow. In the background; the choice of number does not wait for Meta.
        const siteId = (config.site && typeof config.site === 'object' ? (config.site as { id?: string | number }).id : config.site) as string | number | undefined
        if (siteId != null) {
            setTimeout(() => {
                syncAllTemplatesForSite({ payload: req.payload, req, host }, siteId).catch((err: unknown) =>
                    req.payload.logger.error(`[meta:templates] submitting a new site's templates failed: ${err}`))
            }, 2000)
        }
        return Response.json({
            ok: true,
            phoneNumberId: chosen.id,
            displayPhone: chosen.displayPhone,
            wabaId: chosen.wabaId,
            webhookSubscribed: subscription.ok,
            ...(subscription.ok ? {} : { webhookWarning: subscription.error }),
        })
    },
})

export const metaWhatsAppSelectEndpoint: Endpoint = createMetaWhatsAppSelectEndpoint()
