import type { Payload } from 'payload'

import { asCollectionSlug } from '../types'
import { valueAtPath } from '../templates/body'
import type { ApprovalRecord } from '../types/approvals'

import { decryptCredential } from '../utils/metaCrypto'
import { explainTemplateSendError } from '../whatsapp/templateErrors'
import { toE164Digits } from './phone'
import type { ApprovedTemplateReference, MetaCloudGateway, NotificationChannelProvider } from './types'

/**
 * The official WhatsApp Cloud API as a delivery service for the host CMS's WhatsApp notification channel.
 *
 * It sends from the number a site chose on its Facebook login (the `meta-config` collection), when the site turned official
 * WhatsApp on there. Where the host has another WhatsApp service (OpenWA), this one is asked first.
 */

// Outbound sends run inside notification and job paths: bound them so a slow provider cannot hang the caller.
const WHATSAPP_TIMEOUT_MS = 10000

type SendResult = { ok: boolean; retryable?: boolean; error?: string }

async function sendViaMetaCloud(
  to: string,
  text: string,
  cfg: MetaCloudGateway,
  log?: { warn: (msg: string) => void; error: (msg: string) => void },
  template?: ApprovedTemplateReference | null,
): Promise<SendResult> {
  const payload = template
    ? {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: template.name,
          language: { code: template.languageCode },
          components: [
            {
              type: 'body',
              parameters: template.bodyParameters.map((value) => ({ type: 'text', ...(value.name ? { parameter_name: value.name } : {}), text: value.text })),
            },
          ],
        },
      }
    : {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v20.0/${cfg.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.accessToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WHATSAPP_TIMEOUT_MS),
      },
    )

    if (!res.ok) {
      const body = await res.text()
      // A template still in review is worth holding: it will send after Meta
      // approves it. Other 4xx responses are about this message, not a blip.
      const explained = explainTemplateSendError(body)
      const retryable = explained?.retryable ?? (res.status >= 500 || res.status === 429)
      log?.[retryable ? 'warn' : 'error'](
        `[meta:whatsapp] send ${retryable ? 'deferred' : 'failed'} (${res.status}): ${body}`,
      )
      return {
        ok: false,
        retryable,
        error: explained?.error ?? `Meta Cloud responded ${res.status}: ${body.slice(0, 200)}`,
      }
    }

    return { ok: true }
  } catch (err) {
    log?.warn(`[meta:whatsapp] network error (will retry): ${err}`)
    return { ok: false, retryable: true, error: `Meta Cloud unreachable: ${err instanceof Error ? err.message : String(err)}` }
  }
}


/** A site's numeric id from its slug. */
async function siteIdForSlug(payload: Payload, slug: string): Promise<number | undefined> {
  try {
    const found = await payload.find({ collection: 'sites' as never, where: { slug: { equals: slug } } as never, limit: 1, depth: 0, overrideAccess: true, select: { id: true } as never })
    const id = (found.docs[0] as { id?: number } | undefined)?.id
    return typeof id === 'number' ? id : undefined
  } catch {
    return undefined
  }
}

/** The number a site chose on its Facebook login, when it turned official WhatsApp on there. */
async function officialNumberFor(payload: Payload, siteSlug: string): Promise<MetaCloudGateway | null> {
  const siteId = await siteIdForSlug(payload, siteSlug)
  if (siteId == null) return null
  try {
    const found = await payload.find({
      collection: 'meta-config' as never,
      where: {
        and: [{ site: { equals: siteId } }, { isActive: { equals: true } }, { whatsappEnabled: { equals: true } }],
      } as never,
      limit: 1,
      depth: 0,
      overrideAccess: true,
      context: { preventMasking: true },
    })
    const cfg = found.docs[0] as unknown as Record<string, unknown> | undefined
    if (cfg?.authMethod !== 'oauth') return null
    const phoneNumberId = typeof cfg?.whatsappPhoneNumberId === 'string' ? cfg.whatsappPhoneNumberId.trim() : ''
    const raw = cfg?.oauthUserAccessToken || cfg?.accessToken
    if (!phoneNumberId || typeof raw !== 'string' || !raw || raw.includes('•')) return null
    const accessToken = decryptCredential(raw)
    if (!accessToken || accessToken.startsWith('enc:') || accessToken.includes('•')) return null
    return { phoneNumberId, accessToken, siteId }
  } catch (err) {
    payload.logger.warn(`[meta:whatsapp] official WhatsApp lookup failed: ${err}`)
    return null
  }
}

export const metaWhatsAppChannel: NotificationChannelProvider<MetaCloudGateway> = {
  id: 'meta-whatsapp',
  channel: 'whatsapp',
  priority: 10,
  // Nothing set in the settings: a gateway in the environment is tried after the host's other WhatsApp service.
  environmentPriority: 20,

  // The on/off switch of the host's WhatsApp tab; a host without one leaves the channel on.
  isEnabled: (settings) => settings?.whatsapp_enabled !== false,

  async resolve({ payload, siteSlug }) {
    return siteSlug ? officialNumberFor(payload, siteSlug) : null
  },

  resolveFromEnvironment() {
    const phoneNumberId = process.env.META_PHONE_NUMBER_ID
    const accessToken = process.env.META_ACCESS_TOKEN
    return phoneNumberId && accessToken ? { phoneNumberId, accessToken } : null
  },

  async send({ payload, config, to, message, template, templateKey, variables }) {
    const normalised = toE164Digits(to, process.env.WHATSAPP_DEFAULT_COUNTRY_CODE ?? '234')
    if (!normalised) {
      payload.logger.warn('[meta:whatsapp] recipient has no usable digits — message not sent')
      return { success: false, error: 'recipient has no usable digits' }
    }
    // The Cloud API can only open a conversation with a template Meta has approved. When the host names one, that is used. For a
    // notification sent by template key from a site's own number, the plugin sends the template it submitted for that key, once
    // Meta has approved it: only its name and the values go to Meta. Anything else goes out as free text.
    let reference = template ?? null
    if (!reference && templateKey && config.siteId != null) {
      const decision = await approvedTemplateFor(payload, config.siteId, templateKey, variables)
      if (!decision.ok) return { success: false, deferred: decision.wait, error: decision.error }
      reference = decision.reference
    }
    const sent = await sendViaMetaCloud(normalised, message, config, payload.logger, reference)
    if (sent.ok) return { success: true }
    return { success: false, deferred: sent.retryable === true, error: sent.error ?? 'WhatsApp send failed' }
  },
}

type Decision = { ok: true; reference: ApprovedTemplateReference } | { ok: false; wait: boolean; error: string }

const WORDS: Record<string, string> = {
  rejected: 'Meta rejected it',
  paused: 'Meta paused it',
  disabled: 'Meta disabled it',
  invalid: 'its wording does not follow Meta\'s rules',
  failed: 'it could not be submitted to Meta',
}

/** The approved template to send for a notification template key, or why there is none yet. */
async function approvedTemplateFor(payload: Payload, siteId: string | number, templateKey: string, variables: Record<string, unknown>): Promise<Decision> {
  const found = await payload.find({
    collection: asCollectionSlug('meta-approvals'),
    where: { and: [{ site: { equals: siteId } }, { templateKey: { equals: templateKey } }] } as never,
    sort: '-createdAt',
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  // The newest wording is the one the owner meant; an older approved one must not be sent in its place.
  const record = found.docs[0] as unknown as ApprovalRecord | undefined
  if (!record) {
    return { ok: false, wait: false, error: `WhatsApp message "${templateKey}" has not been submitted to Meta yet. Save the workflow that sends it again once this site's WhatsApp number is connected.` }
  }
  if (record.status === 'pending') {
    return { ok: false, wait: true, error: `WhatsApp message "${templateKey}" is still with Meta for review. It will be sent once it is approved.` }
  }
  if (record.status !== 'approved') {
    const why = record.rejectionReason ? ` (${record.rejectionReason})` : ''
    return { ok: false, wait: false, error: `WhatsApp message "${templateKey}" cannot be sent: ${WORDS[record.status] ?? record.status}${why}. Change its wording to submit it again.` }
  }
  const parameters = (record.parameters ?? []).map((parameter) => ({ name: parameter.name, text: valueAtPath(variables, parameter.path) || '-' }))
  return { ok: true, reference: { name: record.metaName, languageCode: record.language, bodyParameters: parameters } }
}
