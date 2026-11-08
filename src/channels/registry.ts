import type { NotificationChannelProvider } from './types'

/**
 * Register a provider with the host CMS's notification channel registry.
 *
 * The registry lives on `globalThis` under a well-known symbol, so the plugin and the host share it without either importing
 * the other. A host without a registry just keeps the entries here and never asks for them. Registering an id again replaces
 * the earlier entry (a hot reload registers twice).
 */
const REGISTRY_KEY = Symbol.for('opscms.notificationChannelProviders')

export function registerNotificationChannel(provider: NotificationChannelProvider<unknown>): void {
    const holder = globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>
    const registry = (holder[REGISTRY_KEY] ??= new Map())
    registry.set(provider.id, provider)
}
