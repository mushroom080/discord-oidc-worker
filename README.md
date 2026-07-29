# Discord OIDC Provider for Cloudflare Access

Use Discord accounts as identities in Cloudflare Access through a Cloudflare
Worker. The Worker wraps the Discord OAuth2 API in the endpoints required by
Cloudflare's generic OpenID Connect integration and stores its signing key pair
in Workers KV.

The implementation was inspired by
[kimcore/discord-oidc](https://github.com/kimcore/discord-oidc) and
[eidam/cf-access-workers-oidc](https://github.com/eidam/cf-access-workers-oidc),
and is built for [Cloudflare Workers](https://workers.cloudflare.com/) with
[Hono](https://honojs.dev/).

## Prerequisites

- A Cloudflare account with a
  [Cloudflare One team](https://developers.cloudflare.com/cloudflare-one/setup/)
- A [Discord developer application](https://discord.com/developers/applications)
- Node.js 22 or later for manual deployment or local development

In the Discord application, add this OAuth2 redirect URI:

```text
https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/callback
```

You can find the team name in the Cloudflare dashboard under
**Settings > Team name and domain > Team name**.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mushroom080/discord-oidc-worker)

The deployment page asks for the Worker variables and secrets used by this
project:

| Binding | Type | Required | Value |
| --- | --- | --- | --- |
| `DISCORD_CLIENT_ID` | Plain text | Yes | Discord application's Application ID |
| `DISCORD_CLIENT_SECRET` | Secret | Yes | Discord application's OAuth2 client secret |
| `CLOUDFLARE_ACCESS_REDIRECT_URL` | Plain text | Yes | The exact `cloudflareaccess.com/cdn-cgi/access/callback` URL registered in Discord |
| `DISCORD_GUILD_IDS` | Plain text | No | JSON array of Discord guild ID strings, for example `["438781053675634713"]` |
| `DISCORD_TOKEN` | Secret | No | Discord bot token used to retrieve roles for the configured guilds |

Use `[]` for `DISCORD_GUILD_IDS` and leave `DISCORD_TOKEN` blank if you do not
need role claims. Cloudflare
automatically provisions the KV namespace and binds it to the Worker as `KV`;
there is no namespace ID to create or copy manually. The KV namespace stores
only the Worker's OIDC signing key pair.

After deployment, note the Worker URL shown by Cloudflare. The examples below
use `https://discord-oidc.<your-workers-subdomain>.workers.dev`.

## Manual deployment

Clone the repository and install its locked dependencies:

```sh
git clone https://github.com/mushroom080/discord-oidc-worker.git
cd discord-oidc-worker
npm ci
```

Set the three plain-text values under `[vars]` in `wrangler.toml`. Copy
`.dev.vars.example` to `.dev.vars`, then set `DISCORD_CLIENT_SECRET`. Leave
`DISCORD_TOKEN` empty unless you need role claims.

Deploy the Worker and upload the values from `.dev.vars` as secrets:

```sh
npm run deploy -- --secrets-file .dev.vars
```

The equivalent direct Wrangler command is:

```sh
npx wrangler deploy --secrets-file .dev.vars
```

Wrangler automatically provisions and binds the `KV` namespace on the first
deployment. Do not commit `.dev.vars`; it contains credentials.

## Local development

Create the local values file as described above, then start Wrangler:

```sh
npm run dev
```

Wrangler loads the plain-text values from `wrangler.toml` and secrets from
`.dev.vars` for local development. For example:

```toml
[vars]
DISCORD_CLIENT_ID="1056005449054429204"
CLOUDFLARE_ACCESS_REDIRECT_URL="https://example.cloudflareaccess.com/cdn-cgi/access/callback"
DISCORD_GUILD_IDS="[\"438781053675634713\"]"
```

```dotenv
DISCORD_CLIENT_SECRET="replace-with-your-oauth2-secret"
# Optional role integration
DISCORD_TOKEN="replace-with-your-bot-token"
```

## Configure Cloudflare Zero Trust

In the [Cloudflare dashboard](https://one.dash.cloudflare.com), go to
**Zero Trust > Integrations > Identity providers**. Under **Your identity
providers**, select **Add new identity provider**, then choose
**OpenID Connect**.

Configure the generic OIDC provider with these values:

| Field | Value |
| --- | --- |
| Name | Any descriptive name, such as `Discord` |
| App ID | Your Discord Application ID |
| Client secret | Your Discord application's OAuth2 client secret |
| Auth URL | `<worker-url>/authorize/email` |
| Token URL | `<worker-url>/token` |
| Certificate URL | `<worker-url>/jwks.json` |

Use `<worker-url>/authorize/guilds` instead of `/authorize/email` if policies
need the `guilds` claim or Discord role claims.

Do **not** enable **Proof of Key Exchange (PKCE)**. The current Worker does not
validate `code_verifier` or forward PKCE parameters to Discord, so enabling the
Cloudflare setting does not provide PKCE protection. PKCE support is outside
the current implementation.

Under **Optional configurations**, add any custom OIDC claims that policies
need. Common claims are:

- `id`: the user's stable Discord user ID
- `preferred_username`: the Discord username, including a legacy discriminator
  when present
- `name`: the Discord display name, falling back to the username
- `guilds`: guild IDs returned when the `/authorize/guilds` URL is used
- `roles:<guild-id>`: role IDs for a guild configured in
  `DISCORD_GUILD_IDS`

The `email` claim is included in the ID token without adding it as a custom
claim. Save the identity provider, then use **Test** for the new login method to
verify the connection.

Finally, edit the relevant Access application under
**Zero Trust > Access controls > Applications**, enable the new identity
provider, and reference the configured OIDC claims in an Allow policy.

## Role claims

Role claims require the guild authorization endpoint and a Discord bot:

1. In the Discord developer application, create a bot.
2. Generate an OAuth2 installation URL with the `bot` scope and add the bot to
   every guild listed in `DISCORD_GUILD_IDS`. The bot does not need server
   permissions.
3. Set `DISCORD_GUILD_IDS` to a JSON array of guild ID strings.
4. Set `DISCORD_TOKEN` to the bot token.
5. Use `<worker-url>/authorize/guilds` as the Cloudflare Auth URL.
6. Add each `roles:<guild-id>` claim to the identity provider's custom OIDC
   claims.
7. In an Access policy, use `roles:<guild-id>` as the claim name and a Discord
   role ID as the claim value.

Keep bot tokens and OAuth2 client secrets out of source control.
