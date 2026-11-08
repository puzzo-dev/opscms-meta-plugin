import { createHash } from 'node:crypto'

import type { MetaBody, ApprovalParameter } from '../types/approvals'

/**
 * Turning the message a user wrote into what Meta will review.
 *
 * The user writes `Hi {{doc.values.first_name}}, we have your enquiry.` in a notification template. Meta wants named
 * placeholders it can recognise (`{{doc_values_first_name}}`), a sample value for each, and a body that follows its format
 * rules. The conversion keeps a note of which path each name came from, so at send time the values are read from the
 * workflow's data and handed to Meta by name.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.\-[\]]*)\s*\}\}/g
const MAX_BODY = 1024
const MAX_EMOJI = 6
const EMOJI = /\p{Extended_Pictographic}/gu

/** The name Meta accepts (lowercase letters, digits, underscores; starts with a letter) for a path. */
function nameFor(path: string, taken: Set<string>): string {
    let base = path.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    if (!/^[a-z]/.test(base)) base = `v_${base}`
    let name = base
    for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`
    taken.add(name)
    return name
}

const sampleFor = (path: string): string => {
    const last = path.split('.').pop() ?? path
    const words = last.replace(/[_\-[\]]+/g, ' ').trim() || 'value'
    return `Sample ${words}`
}

export type BodyConversion = { ok: true; body: MetaBody } | { ok: false; problems: string[] }

/** Convert a template's message, or say in plain words what Meta would refuse it for. */
export function toMetaBody(message: string): BodyConversion {
    // Meta allows at most one blank line between paragraphs; collapsing more is a fix, not a problem.
    const normalised = message.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!normalised) return { ok: false, problems: ['The message is empty.'] }

    const taken = new Set<string>()
    const byPath = new Map<string, ApprovalParameter>()
    const text = normalised.replace(PLACEHOLDER, (_whole, path: string) => {
        let parameter = byPath.get(path)
        if (!parameter) {
            parameter = { name: nameFor(path, taken), path, example: sampleFor(path) }
            byPath.set(path, parameter)
        }
        return `{{${parameter.name}}}`
    })

    const problems: string[] = []
    if (text.length > MAX_BODY) problems.push(`The message is longer than ${MAX_BODY} characters.`)
    if (/^\s*\{\{[^}]+\}\}/.test(text)) problems.push('The message cannot start with a variable. Put some words before it.')
    if (/\{\{[^}]+\}\}\s*$/.test(text)) problems.push('The message cannot end with a variable. Put some words after it.')
    if (/\}\}[\s.,;:!?\-–—()]*\{\{/.test(text)) problems.push('Two variables cannot sit next to each other. Put words between them.')
    const withoutVariables = text.replace(/\{\{[^}]+\}\}/g, '').replace(/\s+/g, '')
    if (byPath.size > 0 && withoutVariables.length === 0) problems.push('The message cannot be only variables.')
    const words = text.replace(/\{\{[^}]+\}\}/g, ' ').split(/\s+/).filter(Boolean).length
    if (byPath.size > 0 && words < byPath.size * 3) problems.push('The message has too many variables for its length. Meta wants about three words for every variable.')
    if ((text.match(EMOJI) ?? []).length > MAX_EMOJI) problems.push(`The message has more than ${MAX_EMOJI} emoji.`)

    return problems.length ? { ok: false, problems } : { ok: true, body: { text, parameters: [...byPath.values()] } }
}

/** A short fingerprint of the message, so a changed message is a new template for Meta and an unchanged one is not resubmitted. */
export function contentHash(message: string): string {
    return createHash('sha256').update(message.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 12)
}

/** Meta's name for a site's template: lowercase letters, digits and underscores, unique per site, key and wording. */
export function metaTemplateName(siteId: string | number, templateKey: string, hash: string): string {
    const key = templateKey.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'message'
    return `opscms_${String(siteId).replace(/[^a-z0-9]/gi, '')}_${key}_${hash.slice(0, 8)}`
}

/** The value of a dotted path in the workflow's data, as one clean line for Meta (no tabs or line breaks, bounded). */
export function valueAtPath(data: Record<string, unknown>, path: string): string {
    const parts = path.replace(/\[(\w+)\]/g, '.$1').split('.')
    let current: unknown = data
    for (const part of parts) {
        if (current == null || typeof current !== 'object') return ''
        current = (current as Record<string, unknown>)[part]
    }
    const raw = current == null ? '' : typeof current === 'object' ? '' : String(current)
    return raw.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 200)
}
