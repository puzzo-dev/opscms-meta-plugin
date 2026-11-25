/**
 * Thin HTTP clients for Meta's Graph API and the separate Threads API.
 * Mirrors opscms-erpnext-plugin's erpActions.ts erpCall() shape: retry on
 * transient (5xx/network) failures, fail fast on 4xx, parse Meta's error
 * envelope for a useful message instead of a bare status code.
 */

const MAX_RETRIES = 2
const BASE_DELAY_MS = 800

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

interface GraphErrorBody {
    error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_title?: string; error_user_msg?: string }
}

/** Errors Meta answers with a code and nothing a person can act on, said in words they can: keyed by `error_subcode`. */
const KNOWN_SUBCODES: Record<number, string> = {
    1784018: 'This business has not accepted Meta\'s Pixel terms. Open Events Manager for the business, start connecting a Web data source, accept the terms, then try again (or create the Pixel there and choose it here).',
}

/** The words for an error body: ours for a known subcode, else Meta's own message for a person (`error_user_msg`), else its technical one. */
export function explainGraphError(body: GraphErrorBody | null | undefined): string | null {
    const error = body?.error
    if (!error) return null
    if (error.error_subcode && KNOWN_SUBCODES[error.error_subcode]) return KNOWN_SUBCODES[error.error_subcode]
    if (error.error_user_msg) return error.error_user_title ? `${error.error_user_title}: ${error.error_user_msg}` : error.error_user_msg
    return error.message ?? null
}

/**
 * Where a person accepts the Pixel terms for a business: the Pixels (data sources) page of its Events Manager, on Meta's own site (a Meta page cannot be shown inside another site's page, so
 * the panel opens it in a popup). Meta decides what that page shows; it asks for the terms when the business has not accepted them.
 */
export const pixelTermsUrl = (businessId: string): string => `https://business.facebook.com/events_manager2/list/pixel/?business_id=${encodeURIComponent(businessId)}`

/** Meta's `error_subcode` for "the business has not accepted the Pixel terms of service". */
export const PIXEL_TERMS_SUBCODE = 1784018

async function graphFailure(res: Response): Promise<{ error: string; subcode?: number }> {
    try {
        const body = await res.json() as GraphErrorBody
        const said = explainGraphError(body)
        if (said) return { error: said, ...(body.error?.error_subcode ? { subcode: body.error.error_subcode } : {}) }
    } catch { /* keep default */ }
    return { error: `Graph API error: ${res.status}` }
}

async function callWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastErr: Error | undefined
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) })
            if (!res.ok && res.status >= 500 && attempt < MAX_RETRIES) {
                await sleep(BASE_DELAY_MS * Math.pow(2, attempt))
                continue
            }
            return res
        } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err))
            if (attempt < MAX_RETRIES) {
                await sleep(BASE_DELAY_MS * Math.pow(2, attempt))
            }
        }
    }
    throw lastErr ?? new Error('Graph API request failed')
}

export const GRAPH_API_VERSION = 'v21.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`
const THREADS_BASE = 'https://graph.threads.net'

export interface GraphResult<T> {
    ok: boolean
    status: number
    data?: T
    error?: string
    /** Meta's `error_subcode`, when it gave one: lets a caller tell a known case from any other failure. */
    subcode?: number
}

export async function graphGet<T = Record<string, unknown>>(
    path: string,
    params: Record<string, string>,
): Promise<GraphResult<T>> {
    const qs = new URLSearchParams(params).toString()
    const res = await callWithRetry(`${GRAPH_BASE}${path}?${qs}`, { method: 'GET' })
    if (!res.ok) return { ok: false, status: res.status, ...(await graphFailure(res)) }
    return { ok: true, status: res.status, data: (await res.json()) as T }
}

export async function graphPost<T = Record<string, unknown>>(
    path: string,
    params: Record<string, string>,
): Promise<GraphResult<T>> {
    const res = await callWithRetry(`${GRAPH_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
    })
    if (!res.ok) return { ok: false, status: res.status, ...(await graphFailure(res)) }
    return { ok: true, status: res.status, data: (await res.json()) as T }
}

/** JSON body. The token stays in the Authorization header so it is not part of the payload. */
export async function graphPostJson<T = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown>,
    accessToken: string,
): Promise<GraphResult<T>> {
    const res = await callWithRetry(`${GRAPH_BASE}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
    })
    if (!res.ok) return { ok: false, status: res.status, ...(await graphFailure(res)) }
    return { ok: true, status: res.status, data: await readGraphJson<T>(res) }
}

async function readGraphJson<T>(res: Response): Promise<T> {
    const text = await res.text()
    if (!text) return {} as T
    return JSON.parse(text) as T
}

export async function graphDelete<T = Record<string, unknown>>(
    path: string,
    accessToken: string,
): Promise<GraphResult<T>> {
    const res = await callWithRetry(`${GRAPH_BASE}${path}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return { ok: false, status: res.status, ...(await graphFailure(res)) }
    return { ok: true, status: res.status, data: await readGraphJson<T>(res) }
}

export async function threadsGet<T = Record<string, unknown>>(
    path: string,
    params: Record<string, string>,
): Promise<GraphResult<T>> {
    const qs = new URLSearchParams(params).toString()
    const res = await callWithRetry(`${THREADS_BASE}${path}?${qs}`, { method: 'GET' })
    if (!res.ok) return { ok: false, status: res.status, ...(await graphFailure(res)) }
    return { ok: true, status: res.status, data: (await res.json()) as T }
}

export async function threadsPost<T = Record<string, unknown>>(
    path: string,
    params: Record<string, string>,
): Promise<GraphResult<T>> {
    const res = await callWithRetry(`${THREADS_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
    })
    if (!res.ok) return { ok: false, status: res.status, ...(await graphFailure(res)) }
    return { ok: true, status: res.status, data: (await res.json()) as T }
}
