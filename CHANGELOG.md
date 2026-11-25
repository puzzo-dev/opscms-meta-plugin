# Changelog

## 0.7.1

### Fixed

- **No product was ever sent to a Meta catalogue.** The batch call named its items `item_type: PRODUCT`, which Meta no longer accepts ("This value of item_type is not currently supported"), so every sync
  reported "Sent 0 products" with that message and nothing reached the catalogue. It names them `PRODUCT_ITEM` (checked against Meta: that value is accepted).

## 0.7.0

### Added

- **A catalogue item's page address can use the slug of its category: `{category.slug}`.** A shop whose pages are one per category, with the items sizes of it (AvrilBeetails: `/adun/<flavour>`), has no
  slug on its items, so `{slug}` gave every link the item's number and a page that does not exist. The template may now be `https://avrilbeetails.com/adun/{category.slug}`. Both `{slug}` and
  `{category.slug}` may be used together. An item whose category has no slug is left out of the sync and the feed (with a link that leads nowhere Meta would only warn).

### Changed

- **A failed call to Meta says what to do.** Meta's own message for a person is shown when it gives one, and a Pixel that cannot be created because the business has not accepted Meta's Pixel
  terms (error 10, subcode 1784018: "Application does not have permission for this action") says so and where to accept them. A failed Pixel creation is also written to the log.
- **The Pixel terms are accepted from the panel.** When creating a Pixel is refused because the business has not accepted them, the panel shows an "Accept Meta's Pixel terms" button that opens the
  business's Events Manager in a popup (a Meta page cannot be shown inside another site's page, and no call can accept the terms for a person), and creates the Pixel again when the popup is closed. If
  the browser blocks the popup the panel gives the address. The create call answers `termsRequired` and `termsUrl` for this case.

## 0.6.1

### Fixed

- **An organization admin (and an editor) could not create a Meta connection, so no site could be connected.** The create rule refused unless the request already named a
  site, but the admin screen asks "may this person create one?" before there is a document, so the answer was always no and "Create New" never appeared (only a
  super-admin saw it). An admin or editor may now start one. Nothing else is looser: the site is still a required field, an editor is still pinned to their own site,
  and a site that is submitted is still checked against the admin's organization.

## 0.6.0

### Changed (breaking)

- **The platform's Meta app comes from the host, and only from the host.** `metaPlugin({ app: () => ({ appId, appSecret, webhookVerifyToken }) })`: the
  plugin asks for it when it needs it, so a host that keeps the app in its own settings needs nothing on the server, and a change is used at once.
  `META_APP_ID`, `META_APP_SECRET` and `META_WEBHOOK_VERIFY_TOKEN` are **no longer read**: one place to set the app, no second value that can disagree.
  A host that passes no `app` has Meta Connect, Facebook login and the webhook switched off. (`META_ENCRYPTION_KEY` and `META_OAUTH_STATE_SECRET` are
  not part of this: they protect what is stored and signed, so they stay on the server.)

## 0.4.2

### Fixed

- **An admin's page load no longer fires a dozen of the heaviest queries at once.** To scope an admin to the sites of their organization, each
  collection's access rule looked the sites up, reading whole site rows (every menu, footer column and translation) just to keep the ids, and
  all of a request's rules did so at the same moment, each sending its own copy. For an admin with several sites that was enough to time the
  database out ("Failed query: select ... from sites ..."). The lookup now asks for the ids alone and the rules of one request share one query.

## 0.4.1

### Changed

- **Facebook sign-in is closed to two kinds of account.** The platform owner (super-admin) signs in with email and password only, and
  an account that has two-factor sign-in switched on cannot be signed in by Facebook (Facebook cannot give a one-time code, so it
  would be a way round the second factor). Both are checked before any account is linked. The login page explains why with two new
  messages (`not_allowed`, `two_factor`).

## 0.4.0

### Added

- **Sign in to the platform with Facebook.** The login page gets a "Continue with Facebook" button (shown only when the Meta app
  is configured). Facebook is asked for the person's name and email only. If an account already uses that Facebook account, they are
  signed in; otherwise an account whose email is the same as their Facebook email is joined to it, and from then on they sign in by
  Facebook id. Nobody is ever signed in on a different email, and signing in never creates an account (accounts are made by
  invitation). A suspended account is refused, and an account already joined to a different Facebook account is not overwritten.
  The session is the same one a password login creates (the platform's own sign-in hooks run, so audit rows and the sign-in event
  behave as usual). Endpoints: `GET /api/meta-login/status`, `/start`, `/callback`, and `POST /api/meta-login/unlink` for a person
  to disconnect their own Facebook account. A one-time cookie guards against forged sign-ins. The host gains one column on its
  users collection (`facebookId`, unique): it needs a migration. Register `<server>/api/meta-login/callback` as a valid OAuth
  redirect URI in the Meta app's Facebook Login settings. New optional `host.rateLimit` throttles the endpoints.
- The plugin delivers the WhatsApp notification channel itself. A site that
  connected an official WhatsApp number on its Facebook login sends the host
  CMS's notifications from that number, through the Cloud API. The plugin
  registers the service with the host's notification channel registry when it
  is added to the config, so the host needs no Meta code of its own.
- A message goes out as an approved template when the host names one
  (`template: { name, languageCode, bodyParameters }`) and as free text when it
  does not. Building that reference from the user's template is the host's job.
- `META_PHONE_NUMBER_ID` and `META_ACCESS_TOKEN` in the environment are the
  fallback for a host with no connected site.

- **Template approval.** When a workflow that sends a notification template by
  WhatsApp is saved, and the site's WhatsApp carrier is Meta, the plugin submits
  that template's message text to Meta for approval. It is the same plain-text
  message SMS sends: there is no separate "Meta template". The wording is
  converted to Meta's format (the user's `{{doc.values.first_name}}` becomes a
  named placeholder Meta accepts, remembered so the value can be filled in at
  send time) and checked against Meta's rules first, so wording Meta would
  refuse is reported in plain words without being sent. Changing a template's
  wording submits it again; an unchanged one is never resubmitted.
- **Sending waits for approval.** A message goes out by naming the approved
  template and giving the values; Meta fills in its wording. While Meta is still
  reviewing, the message is held and sent once approved. If Meta rejects,
  pauses or disables it, or it could not be submitted, the message is not sent
  by WhatsApp and says why.
- **Alerts.** A template that is not approved raises the host event
  `meta.template.needs_attention` (once per problem), with the template key,
  Meta's reason and the site's name. The host's workflow tells the owner.
- **Status on the template.** The notification template shows a read-only
  "WhatsApp delivery through Meta" line with where each of the signed-in
  person's sites stands. It is computed, not stored, and reads through that
  person's own access.
- Approval status comes back by the webhook below, and a scheduled job
  (`meta-template-status`, every five minutes) asks Meta about templates still in
  review and retries the ones that could not be submitted, so nothing waits for
  ever if the callback is not registered yet. The bookkeeping lives in a hidden
  `meta-approvals` collection (host migration required).
- A webhook for Meta to call: `GET /api/meta-webhook` answers the handshake and
  `POST /api/meta-webhook` receives deliveries. Each delivery's signature
  (`X-Hub-Signature-256`, checked with `META_APP_SECRET`) is verified before
  the body is read. Template changes (approved, rejected, paused,
  recategorised, quality) become host events: `meta.template.status_changed`,
  `meta.template.category_changed`, `meta.template.quality_changed` and
  `meta.template.components_changed`, one per site that connected that
  business account, with a stable `eventId` so a repeat can be dropped. The
  plugin reports; the host's workflows decide what to do. Pass the engine as
  `metaPlugin({ host: { emitSystemEvent } })`.
- Choosing a WhatsApp number subscribes that business account to the app with
  the site's own token, and Disconnect removes the subscription, so Meta sends
  that account's events to the webhook.

### Removed

- The three templates written into the plugin (`ops_enquiry_guest`,
  `ops_enquiry_owner`, `ops_alerts_ready`), with their wording and their fixed
  variable paths, and everything built on them: filing them with Meta when a
  number is chosen, the `GET`/`POST /meta-whatsapp/templates` endpoints, the
  alert-status card on the connect screen, the `whatsapp-alert-approval` job
  and the `whatsappAlertsAnnouncedAt` field. Message templates are the user's,
  written in the host's automation; submitting those for Meta's approval is
  the next piece of work.
- `whatsappTemplateMessage`, `alertStatusForConfig`, `fileMissingAlertTemplates`
  and `WHATSAPP_ALERTS_READY_KEY` are no longer exported.
  `explainTemplateSendError` stays.
- The host no longer reads the older manual Cloud API fields from its own
  notification settings. The connection screen is the way to set up an
  official number.

## 0.3.2

### Fixed

- The workflow conversion step stays on the collection the plugin registers.
  The previous release wrote that step onto the original collection and returned
  a different object.

## 0.3.1

### Fixed

- An organization admin can configure Meta for every site in their organization.
  Their account has no single site, and the previous check rejected that account.

## 0.3.0

### Added

- Each site connects with its own Facebook login. The connection screen shows
  that account's name, and another site cannot reuse it.
- Commerce catalogue items sync to the site's Meta catalog when they are
  saved or deleted. A "Sync commerce products now" action sends the whole
  catalogue, the same way the WooCommerce Facebook plugin pushes products.
- After Facebook login, the same screen asks for the Page, catalog, and
  Pixel. A site with none can create the catalog or Pixel there.
- Official WhatsApp numbers on that Facebook login can be chosen for Payload
  notifications. The OpenWA bridge remains for sites that do not choose one.
- Choosing that number files the enquiry alert messages on the site's own
  WhatsApp account, including a short note that alerts are ready. The connect
  screen shows one status — preparing, Meta is reviewing (safe to leave),
  ready, or a single retry — and official alerts send as those messages once
  Meta approves them. The CMS keeps checking and tells the owner through a
  workflow when that happens.

## 0.2.2

### Added

- Test suite for credential encryption, OAuth state signing, Conversions API
  payloads, the catalog feed, and per-site access control.

### Fixed

- Resetting the encryption key in tests left the OAuth state secret cached, so
  a later test could accept a state token signed with the previous secret.

### Changed

- Removed unsafe casts in the plugin source.
- Documented the canonical sources for the mirrored `organizationField` and
  credential-crypto helpers.

## 0.2.1

### Fixed

- Removed a hardcoded fallback secret.

### Changed

- Widened the `@payloadcms/ui` peer dependency to `^3.84.1 || ^3.86.0`.

## 0.2.0

### Added

- One platform Meta App (`META_APP_ID` / `META_APP_SECRET`) for every tenant.
  Sites connect through it with OAuth. They do not create their own App, and
  the admin UI shows a masked App ID plus the connected Page and Instagram
  account.
- SHA-256 hashing of email and phone on the Trigger Meta Conversion Event
  step, so match data sent to Meta is never the raw value.

### Changed

- Commerce Catalog feed currency default is NGN.
- Production startup fails without `META_ENCRYPTION_KEY` unless
  `ALLOW_PLAINTEXT_META_CREDS=true`.

## 0.1.0

### Added

- Initial release. Per-site `meta-config` with encrypted credentials, Meta
  Business Login, Threads connect, server-side Conversions API, and a Commerce
  Catalog CSV feed.
