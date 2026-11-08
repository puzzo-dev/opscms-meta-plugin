import type { Payload } from 'payload'

/**
 * The notification channel protocol of the host CMS.
 *
 * A host that sends notifications keeps a registry of services that deliver channels it does not send itself (WhatsApp, SMS).
 * This is the shape of one entry, declared here so the plugin needs nothing from the host to register. The host's own
 * declaration is the same shape (payload-cms: src/types/notificationChannels.ts).
 */

export type PluggableChannel = 'whatsapp' | 'sms'

export interface ChannelSendOutcome {
    success: boolean
    /** The channel was not set up for this site: a configuration state, not a delivery failure. */
    skipped?: boolean
    /** A transient condition (5xx, timeout): the same message is worth sending again shortly. */
    deferred?: boolean
    error?: string
}

export interface ChannelResolveInput {
    payload: Payload
    siteSlug?: string
    /** The channel's own group of the host's notification settings that apply to the site, if any. */
    settings?: Record<string, unknown>
    platformSettings: boolean
}

/**
 * A template Meta has already approved, named with the values for its numbered slots. Building this from the user's template
 * and the workflow's data is the host automation's job; the plugin only sends it.
 */
export interface ApprovedTemplateReference {
    name: string
    languageCode: string
    /** The values for the template's placeholders, by name when the template uses named placeholders. */
    bodyParameters: Array<{ name?: string; text: string }>
}

export interface ChannelSendInput<Config> {
    payload: Payload
    config: Config
    to: string
    message: string
    /** Set when the message must go out as an approved template. Without it the message is sent as free text. */
    template?: ApprovedTemplateReference | null
    templateKey?: string
    variables: Record<string, unknown>
}

export interface NotificationChannelProvider<Config = unknown> {
    id: string
    channel: PluggableChannel
    /** Order among providers of the same channel when settings are read. Lower goes first. */
    priority: number
    /** Order among providers when nothing is set in the settings and the environment is read. */
    environmentPriority?: number
    isEnabled(settings?: Record<string, unknown>): boolean
    resolve(input: ChannelResolveInput): Promise<Config | null>
    resolveFromEnvironment?(): Config | null
    send(input: ChannelSendInput<Config>): Promise<ChannelSendOutcome>
}

/** A WhatsApp Business number to send from, and the token that may use it. */
export interface MetaCloudGateway {
    phoneNumberId: string
    accessToken: string
    /** The site the number belongs to, when it comes from a site's connection. Its approved templates are looked up by it. */
    siteId?: string | number
}
