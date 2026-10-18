---
title: Single sign-on & SCIM
section: Administration
summary: Sign people in through Keycloak, Entra ID, Google, Yandex, SAML or LDAP; map their groups to roles; provision them over SCIM; and require it.
---

# Single sign-on & SCIM

A workspace can sign people in through its own identity provider (IdP), take
their roles from the IdP's groups, let the directory create and remove them, and
refuse every session the IdP did not open. All of it lives under
**Settings → Security**, for workspace admins.

## Before you start

The operator turns each part on. With the defaults, none of it exists.

| Variable                           | Turns on                                                               |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `AUTH_MODE=api-key`                | real accounts; every SSO and SCIM route needs it                       |
| `AUTH_SSO_ENABLED=true`            | OpenID Connect and SAML providers, enforced SSO, domains               |
| `AUTH_LDAP_ENABLED=true`           | LDAP / Active Directory providers, on top of `AUTH_SSO_ENABLED`        |
| `AUTH_SCIM_ENABLED=true`           | SCIM provisioning at `<API_PUBLIC_URL>/v1/scim/v2`, independent of SSO |
| `SETTINGS_ENCRYPTION_KEY`          | storing a client secret, a SAML key or an LDAP password                |
| `AUTH_SSO_ALLOW_PRIVATE_URLS=true` | an IdP or directory on a private address, the usual on-prem case       |

The full list is in [Running it](/settings/docs/operations).

## Add a provider

**Settings → Security → Providers → Add provider.** Pick the protocol, and for
OpenID Connect a preset. New providers start disabled. Fill in the form, press
**Test**, then enable it.

Three settings decide who gets in:

- **Allowed email domains.** The email domains this provider may vouch for, e.g.
  `corp.example`. A sign-in links to an existing account, or creates one, only
  for an address the IdP has verified on one of these domains. Leave it empty
  and the provider can sign in only people it has already linked.
- **Create accounts on first sign-in** (JIT), with a **Role for new members**.
  Off, a person must already have an account.
- **Show a button on the sign-in page.** Otherwise people reach the provider by typing an
  address on one of its domains.

The Providers tab shows every URL the IdP needs (redirect URI, ACS, metadata,
back-channel logout) with a copy button. Use those values rather than typing
them: they are built from `API_PUBLIC_URL`.

A platform admin can make a provider **platform-wide**, which offers it on
every workspace's login page. That suits a single-company install.

## Keycloak (OpenID Connect)

1. In the realm: **Clients → Create client**, type _OpenID Connect_. Turn on
   **Client authentication** and the **Standard flow**.
2. **Valid redirect URIs**: the redirect URI from our Providers tab.
3. **Credentials** tab: copy the client secret.
4. Groups: in the client's dedicated scope, **Add mapper → By configuration →
   Group Membership**, token claim name `groups`. Turn **Full group path** off
   if you want `engineering` rather than `/engineering`.
5. Here: preset **Keycloak**, issuer `https://<host>/realms/<realm>`, the client
   ID and secret.
6. Optional, to end our sessions when someone signs out of Keycloak: in the
   client's **Advanced** settings, set **Backchannel logout URL** to our
   back-channel URL and turn on **Backchannel logout session required**.
   Keycloak's hostname (`KC_HOSTNAME`) must match the issuer you entered.

For a local trial, `make infra-up-keycloak` starts Keycloak on `:8180` with a
`knowledge` realm and test users.

## Microsoft Entra ID (OpenID Connect)

1. **App registrations → New registration.** Redirect URI, platform _Web_: our
   redirect URI.
2. **Certificates & secrets → New client secret.** Copy the value.
3. **Token configuration**:
   - **Add optional claim** → ID token → `email` and `xms_edov`. Entra sends no
     `email_verified`, and `xms_edov` is the only claim that says the address's
     domain is verified by your tenant. Without it, nobody links or is created.
   - **Add groups claim** for the groups you will map. Entra puts group object
     IDs in the claim, so map by ID.
4. Here: preset **Entra ID**, issuer
   `https://login.microsoftonline.com/<tenant-id>/v2.0` (the tenant ID, not
   `common`), the application (client) ID and the secret. A token from another
   tenant is refused.

A person in more than 200 groups gets a reference instead of a list. That reads
as no groups, so a sign-in takes nothing away from them. For large tenants,
provision over SCIM (below) instead, or emit app roles and set the groups claim
to `roles`.

## Google Workspace (OpenID Connect)

1. Google Cloud console → **APIs & Services → OAuth consent screen**, user
   type _Internal_, so only your organization's accounts can consent.
2. **Credentials → Create credentials → OAuth client ID**, type _Web
   application_, authorized redirect URI: our redirect URI.
3. Here: preset **Google**, the client ID and secret. The issuer is fixed. Set
   **Allowed domains** to your Workspace domain.

Google puts no groups in its tokens. Assign roles by hand, use a default role,
or provision over SCIM.

## Yandex ID

1. [oauth.yandex.ru](https://oauth.yandex.ru) → **Create app**, platform _Web
   services_, redirect URI: our redirect URI.
2. Permissions: access to the email address (`login:email`) and to the name
   (`login:info`).
3. Here: preset **Yandex ID**, the client ID and secret.

Yandex ID is OAuth 2 with a user-info call rather than OpenID Connect: there
is no issuer to enter, no groups and no back-channel logout. It uses the
account's default address, which Yandex has confirmed. Set **Allowed domains**
to your Yandex 360 organization's domain, or any personal Yandex account could
be created.

## SAML 2.0

Pick **SAML 2.0** when adding the provider. Our key pair is generated when you
save, and the tab then shows our **entity ID** (it is the metadata URL), the
**ACS URL** and the **metadata URL**. Most IdPs can import the metadata by URL.

Enter the IdP's **entity ID**, **single sign-on URL** and **signing
certificate**. During a key rollover, paste both certificates. The response or
the assertion must be signed by one of them.

In Keycloak, for example:

1. **Clients → Create client*ц*, type *SAML*. **Client ID\*\*: our metadata URL.
2. **Valid redirect URIs**: our ACS URL. **Name ID format**: _email_ (or
   _persistent_). A transient NameID is refused.
3. **Keys** tab: turn on **Client signature required** and import our
   certificate from the metadata.
4. Groups: **Client scopes → dedicated → Add mapper → Group list**, attribute
   name `groups`, **Single group attribute** on.
5. Here: IdP entity ID `https://<host>/realms/<realm>`, SSO URL
   `https://<host>/realms/<realm>/protocol/saml`, the realm's RS256
   certificate, and `groups` as the groups attribute.

The **Attribute map** names the email, name and groups attributes. Left empty,
the usual Keycloak, Okta, Entra and ADFS names are tried. Groups come only from
a named attribute. Sign-ins started from the IdP's app portal are refused
unless **Accept sign-ins started from the identity provider’s app portal** is
on.

If the operator rotates `SETTINGS_ENCRYPTION_KEY`, SAML providers cannot sign
in until they are recreated. **Test** says so.

## LDAP / Active Directory

Needs `AUTH_LDAP_ENABLED`. The provider's button opens a username and password
form instead of a redirect.

- **URL**: `ldaps://dc.corp.example:636`, or `ldap://…` with **StartTLS** on.
  Plain `ldap://` is refused unless the operator sets `AUTH_LDAP_ALLOW_INSECURE`,
  which sends passwords in clear text.
- **Base DN**, and a read-only **service account** (bind DN and password) to
  search with.
- **User filter**: optional. By default it matches `uid`, `mail`,
  `sAMAccountName` or `userPrincipalName` against what was typed, escaped so it
  cannot widen the search.
- Attributes default to `mail`, `displayName` (or `cn`) and `memberOf`. Group
  mappings match the **full group DN**,
  e.g. `cn=editors,ou=groups,dc=corp,dc=example`.

A directory on an internal CA needs `NODE_EXTRA_CA_CERTS` pointed at the CA in
the API container. Wrong usernames and wrong passwords get the same answer, on
purpose.

## Map groups to roles

**Settings → Security → Group mapping.** Pick the provider (or a SCIM group),
type the group exactly as it arrives in the claim, and choose a role. Tick
**Also make them trusted operators** to grant raw graph queries too.

- The highest mapped role wins. With no match, the provider's role for new
  members applies.
- **Additive** sync only ever raises a role. **Authoritative** sets it from the
  groups at each sign-in, and removes the membership when nothing maps.
- Mappings apply at each person's next sign-in. SCIM group mappings apply as
  soon as the group changes.
- Roles set by hand are never touched. A synced member shows where the role
  comes from on **Access → Members**. To take one over, choose **Manage
  manually**.
- Sync never demotes or removes the last admin. It skips the change and writes
  an audit entry.

## Provision over SCIM

**Settings → Security → Provisioning.** Copy the **SCIM base URL** and create a
token. It is shown once, and it provisions this workspace only.

- **Entra ID:** Enterprise applications → your app → **Provisioning**, mode
  _Automatic_, Tenant URL = the base URL, Secret token = the token.
- **Okta:** the app's **Provisioning → Integration**, SCIM connector base URL
  and an HTTP header bearer token.
- **Keycloak** needs a SCIM plugin.

New people get the **Role without a mapped group** (`viewer` unless changed, or
`none` to grant nothing until a mapped group says more). Deactivating or deleting someone in the IdP
removes the membership and signs them out everywhere. It disables their whole
account only when their email domain is one this workspace has verified, so one
workspace's directory cannot lock someone out of another.

## Require SSO

Do it in this order, so you do not lock yourself out:

1. Add and enable a provider, and **sign in through it yourself**.
2. **Domains**: claim `corp.example`, publish the TXT record shown at
   `_knowledge-challenge.corp.example`, and press **Verify now** (or wait: pending
   claims are rechecked every 15 minutes for a week).
3. **Require single sign-on** on the domain. Password sign-in, signup and reset are now refused for
   its addresses, and the login page sends them to the provider.
4. **Policy**: turn on **Require single sign-on for this workspace**. Every session reaching the
   workspace must now come from one of its providers, on the web, the API, MCP
   clients and live updates alike. Decide whether to **Still accept API keys**,
   and optionally set **Sign in again after (hours)**.

The Policy tab shows what you asked for beside what applies. If SSO is off on
the instance, nothing is enforced, and the tab says so. Saving a policy your own
session would fail is refused.

**Break glass.** Platform admins pass the policy, and every crossing is audited.
Addresses in `AUTH_BREAK_GLASS_EMAILS` can always use a password. A workspace may
also let platform admins keep their password on its enforced domains.

## Sessions and audit

- **Settings → Profile** lists your sessions: how each was opened, its IP,
  browser and last use. Sign any of them out there.
- **Settings → Security → Audit** lists the workspace's sign-ins, provider and
  mapping changes, domain and policy changes, and every provisioning change.
  Sign-ins that belong to no workspace yet are in the platform view, for
  platform admins.
- Deleting a provider signs out the sessions it opened. With back-channel
  logout configured, signing out at the IdP does too.
