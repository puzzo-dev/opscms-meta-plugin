/**
 * What Disconnect writes. These are the values the Facebook login stored for
 * one site: tokens, Page, Instagram, catalog, Pixel, and WhatsApp. The site
 * row itself, its label, and the shop URL template stay, so the owner can
 * connect a different Facebook account without retyping the site.
 */
export function clearedMetaUserConnection(): Record<string, string | false | null> {
    return {
        accessToken: null,
        oauthUserAccessToken: null,
        oauthExpiresAt: null,
        facebookPageId: null,
        facebookPageName: null,
        instagramBusinessAccountId: null,
        instagramUsername: null,
        businessManagerId: null,
        pixelId: null,
        pixelEnabled: false,
        catalogId: null,
        catalogEnabled: false,
        whatsappPhoneNumberId: null,
        whatsappBusinessAccountId: null,
        whatsappEnabled: false,
        authMethod: 'manual',
        connectionStatus: 'disconnected',
    }
}
