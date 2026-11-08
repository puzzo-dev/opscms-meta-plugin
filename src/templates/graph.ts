import { graphGet, graphPostJson } from '../utils/metaGraphClient'
import type { MetaBody, ApprovalStatus } from '../types/approvals'

/**
 * Talking to Meta about templates: submit one for review, and read where one stands.
 *
 * Meta reviews a template once. When it is approved the platform keeps its name; from then on a message is sent by naming it
 * and giving the values for its placeholders, and Meta fills them into the approved wording on its side.
 */

export const TEMPLATE_LANGUAGE = process.env.META_TEMPLATE_LANGUAGE || 'en_US'
/** Notifications about a person's own order, booking or enquiry are utility messages. Meta may recategorise one. */
export const TEMPLATE_CATEGORY = 'UTILITY'

export type SubmitResult =
    | { ok: true; id: string; status: ApprovalStatus; category: string | null; reason: string | null }
    | { ok: false; error: string }

/** Meta's review state as the platform records it. Anything Meta adds later counts as still pending. */
export function statusFromMeta(value: unknown): ApprovalStatus {
    switch (typeof value === 'string' ? value.toUpperCase() : '') {
        case 'APPROVED':
            return 'approved'
        case 'REJECTED':
            return 'rejected'
        case 'PAUSED':
            return 'paused'
        case 'DISABLED':
            return 'disabled'
        default:
            return 'pending'
    }
}

/** Submit a template to a business account for review. Named placeholders, so the user's own variable names carry through. */
export async function submitTemplate(
    token: string,
    wabaId: string,
    template: { name: string; body: MetaBody; language?: string; category?: string },
): Promise<SubmitResult> {
    const { body } = template
    const component: Record<string, unknown> = { type: 'BODY', text: body.text }
    if (body.parameters.length > 0) {
        component.example = { body_text_named_params: body.parameters.map((p) => ({ param_name: p.name, example: p.example })) }
    }
    const result = await graphPostJson<{ id?: string; status?: string; category?: string }>(
        `/${encodeURIComponent(wabaId)}/message_templates`,
        {
            name: template.name,
            language: template.language ?? TEMPLATE_LANGUAGE,
            category: template.category ?? TEMPLATE_CATEGORY,
            parameter_format: 'NAMED',
            components: [component],
        },
        token,
    )
    if (!result.ok) return { ok: false, error: result.error ?? 'Meta refused the template.' }
    const id = result.data?.id
    if (!id) return { ok: false, error: 'Meta accepted the template but did not return its id.' }
    return { ok: true, id: String(id), status: statusFromMeta(result.data?.status), category: result.data?.category ?? null, reason: null }
}

export type ReadResult =
    | { ok: true; status: ApprovalStatus; category: string | null; reason: string | null }
    | { ok: false; error: string }

/** Where a submitted template stands now. */
export async function readTemplate(token: string, templateId: string): Promise<ReadResult> {
    const result = await graphGet<{ status?: string; category?: string; rejected_reason?: string }>(`/${encodeURIComponent(templateId)}`, {
        fields: 'status,category,rejected_reason',
        access_token: token,
    })
    if (!result.ok) return { ok: false, error: result.error ?? 'Meta could not be asked about the template.' }
    const reason = result.data?.rejected_reason && result.data.rejected_reason !== 'NONE' ? result.data.rejected_reason : null
    return { ok: true, status: statusFromMeta(result.data?.status), category: result.data?.category ?? null, reason }
}
