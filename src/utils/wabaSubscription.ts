import { graphDelete, graphPostJson } from './metaGraphClient'

/**
 * Subscribing a customer's WhatsApp business account to the platform's Meta app.
 *
 * Meta only delivers a business account's events (template approvals, quality changes, account alerts) to an app that account
 * has subscribed. The customer's own token, from their Facebook login, is what authorises the subscription; it is made when
 * they choose their number and removed when they disconnect.
 */

export interface SubscriptionResult {
    ok: boolean
    error?: string
}

/** Subscribe the business account to the app that owns the token. Safe to repeat. */
export async function subscribeWabaToApp(token: string, wabaId: string): Promise<SubscriptionResult> {
    if (!token || !wabaId) return { ok: false, error: 'A token and a business account are needed to subscribe.' }
    const result = await graphPostJson(`/${encodeURIComponent(wabaId)}/subscribed_apps`, {}, token)
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'Meta refused the subscription.' }
}

/** Remove the subscription, so Meta stops sending that business account's events here. */
export async function unsubscribeWabaFromApp(token: string, wabaId: string): Promise<SubscriptionResult> {
    if (!token || !wabaId) return { ok: false, error: 'A token and a business account are needed to unsubscribe.' }
    const result = await graphDelete(`/${encodeURIComponent(wabaId)}/subscribed_apps`, token)
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'Meta refused to remove the subscription.' }
}
