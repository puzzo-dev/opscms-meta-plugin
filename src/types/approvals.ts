/**
 * Types of Meta's approval of the notification templates a site sends by WhatsApp.
 */

/** Where a template stands with Meta. `invalid` and `failed` never reached Meta's review. */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled' | 'invalid' | 'failed'

/** One placeholder of the user's template, renamed to what Meta accepts, with where its value comes from at send time. */
export interface ApprovalParameter {
    /** The name Meta knows the placeholder by, e.g. `doc_values_first_name`. */
    name: string
    /** The path in the workflow's data the value is read from, e.g. `doc.values.first_name`. */
    path: string
    /** A sample value for Meta's review. */
    example: string
}

/** The user's message turned into Meta's format. */
export interface MetaBody {
    text: string
    parameters: ApprovalParameter[]
}

/** A row of `meta-approvals` as the plugin reads it (depth 0). */
export interface ApprovalRecord {
    id: number | string
    site: number | string | { id: number | string }
    templateKey: string
    contentHash: string
    metaName: string
    language: string
    category: string | null
    status: ApprovalStatus
    metaTemplateId: string | null
    rejectionReason: string | null
    body: string
    parameters: ApprovalParameter[] | null
    wabaId: string | null
    alertedStatus: string | null
}

/** What a template change needs the site's owner to know. */
export interface TemplateProblem {
    templateKey: string
    status: ApprovalStatus
    reason: string
}
