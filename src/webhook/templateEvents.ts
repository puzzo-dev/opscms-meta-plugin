/**
 * Turning what Meta posts about message templates into events the host can act on.
 *
 * Meta groups changes by business account (`entry[].id`) and field (`entry[].changes[].field`). Only the template fields are
 * read here; everything else the app may be subscribed to is ignored. Each change becomes one normalised event, with a stable
 * `eventId` so the host can drop a delivery Meta repeats (it retries until it gets a 200).
 */

import { createHash } from 'node:crypto'

/** The host-side event name for each Meta field. */
export const TEMPLATE_EVENT_BY_FIELD: Record<string, string> = {
    message_template_status_update: 'meta.template.status_changed',
    template_category_update: 'meta.template.category_changed',
    template_correct_category_detection: 'meta.template.category_changed',
    message_template_quality_update: 'meta.template.quality_changed',
    message_template_components_update: 'meta.template.components_changed',
}

export interface TemplateEvent {
    /** The event name the host's workflows listen for. */
    eventName: string
    /** The WhatsApp business account the template belongs to. */
    wabaId: string
    data: {
        /** Meta's field, e.g. `message_template_status_update`. */
        field: string
        eventId: string
        wabaId: string
        templateId: string | null
        templateName: string | null
        language: string | null
        /** APPROVED, REJECTED, PAUSED, DISABLED, ... for a status change; the new category or quality for the others. */
        status: string | null
        /** Meta's stated reason for a rejection or pause, when it gives one. */
        reason: string | null
    }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : null)

/** Every template change in a delivery. A body that is not a WhatsApp business account notification gives none. */
export function templateEventsFrom(body: unknown): TemplateEvent[] {
    const delivery = body as { object?: unknown; entry?: unknown } | null
    if (!delivery || delivery.object !== 'whatsapp_business_account' || !Array.isArray(delivery.entry)) return []

    const events: TemplateEvent[] = []
    for (const entry of delivery.entry as Array<{ id?: unknown; time?: unknown; changes?: unknown }>) {
        const wabaId = text(entry?.id)
        if (!wabaId || !Array.isArray(entry.changes)) continue
        for (const change of entry.changes as Array<{ field?: unknown; value?: Record<string, unknown> }>) {
            const field = typeof change?.field === 'string' ? change.field : ''
            const eventName = TEMPLATE_EVENT_BY_FIELD[field]
            if (!eventName) continue
            const value = change.value ?? {}
            const templateId = text(value.message_template_id)
            const status = text(value.event) ?? text(value.new_category) ?? text(value.new_quality_score) ?? text(value.correct_category)
            const reason = text(value.reason) ?? text((value.disable_info as { disable_date?: unknown } | undefined)?.disable_date)
            const eventId = createHash('sha256')
                .update(JSON.stringify([wabaId, field, entry.time ?? null, templateId, status, reason]))
                .digest('hex')
                .slice(0, 32)
            events.push({
                eventName,
                wabaId,
                data: {
                    field,
                    eventId,
                    wabaId,
                    templateId,
                    templateName: text(value.message_template_name),
                    language: text(value.message_template_language),
                    status,
                    reason,
                },
            })
        }
    }
    return events
}
