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
    error?: { message?: string; type?: string; code?: number }
}

async function parseGraphError(res: Response): Promise<string> {
    try {
        const body = await res.json() as GraphErrorBody
        if (body?.error?.message) return body.error.message
    } catch { /* keep default */ }
    return `Graph API error: ${res.status}`
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
}

export async function graphGet<T = Record<string, unknown>>(
    path: string,
    params: Record<string, string>,
): Promise<GraphResult<T>> {
    const qs = new URLSearchParams(params).toString()
    const res = await callWithRetry(`${GRAPH_BASE}${path}?${qs}`, { method: 'GET' })
    if (!res.ok) return { ok: false, status: res.status, error: await parseGraphError(res) }
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
    if (!res.ok) return { ok: false, status: res.status, error: await parseGraphError(res) }
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
    if (!res.ok) return { ok: false, status: res.status, error: await parseGraphError(res) }
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
    if (!res.ok) return { ok: false, status: res.status, error: await parseGraphError(res) }
    return { ok: true, status: res.status, data: await readGraphJson<T>(res) }
}

export async function threadsGet<T = Record<string, unknown>>(
    path: string,
    params: Record<string, string>,
): Promise<GraphResult<T>> {
    const qs = new URLSearchParams(params).toString()
    const res = await callWithRetry(`${THREADS_BASE}${path}?${qs}`, { method: 'GET' })
    if (!res.ok) return { ok: false, status: res.status, error: await parseGraphError(res) }
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
    if (!res.ok) return { ok: false, status: res.status, error: await parseGraphError(res) }
    return { ok: true, status: res.status, data: (await res.json()) as T }
}
