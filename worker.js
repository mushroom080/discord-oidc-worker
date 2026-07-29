import { Hono } from 'hono'
import * as jose from 'jose'

class ConfigurationError extends Error {
	constructor(message) {
		super(message)
		this.name = 'ConfigurationError'
	}
}

function requireStringBinding(env, name) {
	const value = env?.[name]

	if (typeof value !== 'string' || value.trim() === '') {
		throw new ConfigurationError(`${name} must be set to a non-empty string.`)
	}

	return value
}

function loadGuildIds(value) {
	if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
		return []
	}

	let guildIds = value

	if (typeof value === 'string') {
		try {
			guildIds = JSON.parse(value)
		} catch {
			throw new ConfigurationError('DISCORD_GUILD_IDS must be a valid JSON array of strings.')
		}
	}

	if (!Array.isArray(guildIds) || !guildIds.every(guildId => typeof guildId === 'string')) {
		throw new ConfigurationError('DISCORD_GUILD_IDS must be an array of strings.')
	}

	return [...guildIds]
}

export function loadConfig(env) {
	const clientId = requireStringBinding(env, 'DISCORD_CLIENT_ID')
	const clientSecret = requireStringBinding(env, 'DISCORD_CLIENT_SECRET')
	const redirectURL = requireStringBinding(env, 'CLOUDFLARE_ACCESS_REDIRECT_URL')
	const guildIds = loadGuildIds(env?.DISCORD_GUILD_IDS)
	const discordTokenValue = env?.DISCORD_TOKEN
	const discordToken = typeof discordTokenValue === 'string' && discordTokenValue.trim() !== ''
		? discordTokenValue
		: undefined

	if (discordTokenValue !== undefined && discordTokenValue !== null
		&& typeof discordTokenValue !== 'string') {
		throw new ConfigurationError('DISCORD_TOKEN must be a string when set.')
	}

	if (guildIds.length > 0 && discordToken === undefined) {
		throw new ConfigurationError('DISCORD_TOKEN must be set when DISCORD_GUILD_IDS is not empty.')
	}

	if (!env?.KV || typeof env.KV.get !== 'function' || typeof env.KV.put !== 'function') {
		throw new ConfigurationError('KV must be bound to a KV namespace.')
	}

	return {
		clientId,
		clientSecret,
		redirectURL,
		guildIds,
		discordToken,
		KV: env.KV
	}
}

const algorithm = {
	name: 'RSASSA-PKCS1-v1_5',
	modulusLength: 2048,
	publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
	hash: { name: 'SHA-256' },
}

const importAlgo = {
	name: 'RSASSA-PKCS1-v1_5',
	hash: { name: 'SHA-256' },
}

async function loadOrGenerateKeyPair(KV) {
	let keyPair = {}
	let keyPairJson = await KV.get('keys', { type: 'json' })

	if (keyPairJson !== null) {
		keyPair.publicKey = await crypto.subtle.importKey('jwk', keyPairJson.publicKey, importAlgo, true, ['verify'])
		keyPair.privateKey = await crypto.subtle.importKey('jwk', keyPairJson.privateKey, importAlgo, true, ['sign'])

		return keyPair
	} else {
		keyPair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])

		await KV.put('keys', JSON.stringify({
			privateKey: await crypto.subtle.exportKey('jwk', keyPair.privateKey),
			publicKey: await crypto.subtle.exportKey('jwk', keyPair.publicKey)
		}))

		return keyPair
	}

}

const app = new Hono()

app.use('*', async (c, next) => {
	c.set('config', loadConfig(c.env))
	await next()
})

app.onError((error, c) => {
	if (error instanceof ConfigurationError) {
		return c.text(`Configuration error: ${error.message}`, 500)
	}

	return c.text('Internal Server Error', 500)
})

app.get('/authorize/:scopemode', async (c) => {
	const config = c.get('config')

	if (c.req.query('client_id') !== config.clientId
		|| c.req.query('redirect_uri') !== config.redirectURL
		|| !['guilds', 'email'].includes(c.req.param('scopemode'))) {
		return c.text('Bad request.', 400)
	}

	const params = new URLSearchParams({
		'client_id': config.clientId,
		'redirect_uri': config.redirectURL,
		'response_type': 'code',
		'scope': c.req.param('scopemode') == 'guilds' ? 'identify email guilds' : 'identify email',
		'state': c.req.query('state'),
		'prompt': 'none'
	}).toString()

	return c.redirect('https://discord.com/oauth2/authorize?' + params)
})

app.post('/token', async (c) => {
	const config = c.get('config')
	const body = await c.req.parseBody()
	const code = body['code']
	const params = new URLSearchParams({
		'client_id': config.clientId,
		'client_secret': config.clientSecret,
		'redirect_uri': config.redirectURL,
		'code': code,
		'grant_type': 'authorization_code',
		'scope': 'identify email'
	}).toString()

	const r = await fetch('https://discord.com/api/v10/oauth2/token', {
		method: 'POST',
		body: params,
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		}
	}).then(res => res.json())

	if (r === null) return new Response("Bad request.", { status: 400 })
	const userInfo = await fetch('https://discord.com/api/v10/users/@me', {
		headers: {
			'Authorization': 'Bearer ' + r['access_token']
		}
	}).then(res => res.json())

	if (!userInfo['verified']) return c.text('Bad request.', 400)

	let servers = []

	const serverResp = await fetch('https://discord.com/api/v10/users/@me/guilds', {
		headers: {
			'Authorization': 'Bearer ' + r['access_token']
		}
	})

	if (serverResp.status === 200) {
		const serverJson = await serverResp.json()
		servers = serverJson.map(item => {
			return item['id']
		})
	}

	let roleClaims = {}

	if (config.discordToken && config.guildIds.length > 0) {
		await Promise.all(config.guildIds.map(async guildId => {
			if (servers.includes(guildId)) {
				let memberPromise = fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userInfo['id']}`, {
					headers: {
						'Authorization': 'Bot ' + config.discordToken
					}
				})
				// i had issues doing this any other way?
				const memberResp = await memberPromise
				const memberJson = await memberResp.json()

				roleClaims[`roles:${guildId}`] = memberJson.roles
			}

		}
		))
	}

	let preferred_username = userInfo['username']

	if (userInfo['discriminator'] && userInfo['discriminator'] !== '0'){
		preferred_username += `#${userInfo['discriminator']}`
	}

	let displayName = userInfo['global_name'] ?? userInfo['username']

	const idToken = await new jose.SignJWT({
		iss: 'https://cloudflare.com',
		aud: config.clientId,
		preferred_username,
		...userInfo,
		...roleClaims,
		email: userInfo['email'],
		global_name: userInfo['global_name'],
		name: displayName,
		guilds: servers
	})
		.setProtectedHeader({ alg: 'RS256' })
		.setExpirationTime('1h')
		.setAudience(config.clientId)
		.sign((await loadOrGenerateKeyPair(config.KV)).privateKey)

	return c.json({
		...r,
		scope: 'identify email',
		id_token: idToken
	})
})

app.get('/jwks.json', async (c) => {
	const config = c.get('config')
	let publicKey = (await loadOrGenerateKeyPair(config.KV)).publicKey
	return c.json({
		keys: [{
			alg: 'RS256',
			kid: 'jwtRS256',
			...(await crypto.subtle.exportKey('jwk', publicKey))
		}]
	})
})

export default app
