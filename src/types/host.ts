import type { Payload, PayloadRequest } from 'payload'

/**
 * What the plugin asks of the host CMS, beyond Payload itself.
 *
 * The host passes this to `metaPlugin({ host })`. The plugin never owns a workflow or a message template: both belong to the
 * host's automation. When something happens on Meta's side (a template is approved, rejected or recategorised) the plugin
 * tells the host with an event, and the host's workflows decide what to do about it. Without a host the plugin still connects
 * sites to Meta and sends WhatsApp; it just has nobody to tell.
 */

/** What happened when the host fired a system event. */
export interface HostEventOutcome {
    enqueued: number
    failed: number
}

export interface MetaHost {
    /** Fire a named system event for a site, so the workflows listening for it run. */
    emitSystemEvent(
        payload: Payload,
        eventName: string,
        event: { siteSlug: string; data: Record<string, unknown> },
        req: PayloadRequest,
    ): Promise<HostEventOutcome>
    /**
     * Make sure the site has a workflow in the host's automation that handles this event. The workflow, and the message the
     * owner receives, are the host's: it decides how the event becomes an action. Does nothing when one already exists.
     */
    ensureEventHandler(payload: Payload, eventName: string, site: { id: string | number; organizationId: string | number }): Promise<void>
    /**
     * Throttling for the sign-in endpoints, from the host's own limiter. Without it they are not throttled by the plugin (a
     * sign-in needs a code Facebook has just issued, so there is little to guess).
     */
    rateLimit?: {
        check(key: string, maxRequests: number, windowMs: number): Promise<{ allowed: boolean }>
        clientIp(req: PayloadRequest): string
    }
}
