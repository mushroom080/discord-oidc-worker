import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importJWK, jwtVerify } from 'jose'

import app from '../worker.js'

const clientId = 'test-discord-client'
const clientSecret = 'test-discord-secret'
const redirectUrl = 'https://access.example.com/callback'
const workerOrigin = 'https://worker.example.com'

function bindings(overrides = {}) {
	return {
		DISCORD_CLIENT_ID: clientId,
		DISCORD_CLIENT_SECRET: clientSecret,
		CLOUDFLARE_ACCESS_REDIRECT_URL: redirectUrl,
		KV: env.KV,
		...overrides,
	}
}

function workerRequest(path, init, overrides) {
	return app.request(
		`${workerOrigin}${path}`,
		init,
		bindings(overrides),
	)
}

async function expectConfigurationError(response, bindingName) {
	expect(response.status).toBe(500)

	const text = await response.text()
	expect(text).toContain('Configuration error:')
	expect(text).toContain(bindingName)
	expect(text).not.toContain(clientSecret)
}

describe('Worker configuration', () => {
	it.each([
		'DISCORD_CLIENT_ID',
		'DISCORD_CLIENT_SECRET',
		'CLOUDFLARE_ACCESS_REDIRECT_URL',
		'KV',
	])('rejects a missing %s binding without exposing secrets', async (bindingName) => {
		const testBindings = bindings()
		delete testBindings[bindingName]

		const response = await app.request(
			`${workerOrigin}/authorize/email?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=test-state`,
			undefined,
			testBindings,
		)

		await expectConfigurationError(response, bindingName)
	})

	it.each([
		{ name: 'an unset value', value: undefined },
		{ name: 'an empty value', value: '' },
		{ name: 'an empty JSON array', value: '[]' },
		{ name: 'an empty array binding', value: [] },
	])('accepts DISCORD_GUILD_IDS as $name', async ({ value }) => {
		const overrides = {}
		if (value !== undefined) overrides.DISCORD_GUILD_IDS = value

		const response = await workerRequest(
			`/authorize/email?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=test-state`,
			undefined,
			overrides,
		)

		expect(response.status).toBe(302)
	})

	it.each([
		{
			name: 'a JSON string',
			value: '["guild-one","guild-two"]',
		},
		{
			name: 'an array binding',
			value: ['guild-one', 'guild-two'],
		},
	])('accepts DISCORD_GUILD_IDS as $name when DISCORD_TOKEN is present', async ({ value }) => {
		const response = await workerRequest(
			`/authorize/guilds?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=test-state`,
			undefined,
			{
				DISCORD_GUILD_IDS: value,
				DISCORD_TOKEN: 'test-bot-token',
			},
		)

		expect(response.status).toBe(302)
	})

	it.each([
		{ name: 'invalid JSON', value: 'not-json' },
		{ name: 'a JSON scalar', value: '"guild-one"' },
		{ name: 'a JSON object', value: '{"guild":"guild-one"}' },
		{ name: 'a JSON array containing a number', value: '["guild-one",42]' },
		{ name: 'an array binding containing a number', value: ['guild-one', 42] },
	])('rejects DISCORD_GUILD_IDS containing $name', async ({ value }) => {
		const response = await workerRequest(
			`/authorize/email?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=test-state`,
			undefined,
			{
				DISCORD_GUILD_IDS: value,
				DISCORD_TOKEN: 'test-bot-token',
			},
		)

		await expectConfigurationError(response, 'DISCORD_GUILD_IDS')
	})

	it('requires DISCORD_TOKEN when one or more guild IDs are configured', async () => {
		const response = await workerRequest(
			`/authorize/guilds?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=test-state`,
			undefined,
			{
				DISCORD_GUILD_IDS: '["guild-one"]',
			},
		)

		await expectConfigurationError(response, 'DISCORD_TOKEN')
	})
})

describe('authorization endpoints', () => {
	it.each([
		{
			mode: 'email',
			expectedScope: 'identify email',
		},
		{
			mode: 'guilds',
			expectedScope: 'identify email guilds',
		},
	])('redirects /authorize/$mode to Discord with the expected scope', async ({
		mode,
		expectedScope,
	}) => {
		const response = await workerRequest(
			`/authorize/${mode}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=opaque-state`,
		)

		expect(response.status).toBe(302)

		const location = new URL(response.headers.get('location'))
		expect(location.origin).toBe('https://discord.com')
		expect(location.pathname).toBe('/oauth2/authorize')
		expect(location.searchParams.get('client_id')).toBe(clientId)
		expect(location.searchParams.get('redirect_uri')).toBe(redirectUrl)
		expect(location.searchParams.get('response_type')).toBe('code')
		expect(location.searchParams.get('scope')).toBe(expectedScope)
		expect(location.searchParams.get('state')).toBe('opaque-state')
		expect(location.searchParams.get('prompt')).toBe('none')
	})

	it('rejects authorization requests for another client', async () => {
		const response = await workerRequest(
			`/authorize/email?client_id=another-client&redirect_uri=${encodeURIComponent(redirectUrl)}&state=opaque-state`,
		)

		expect(response.status).toBe(400)
		expect(await response.text()).toBe('Bad request.')
	})
})

describe('token and signing-key endpoints', () => {
	beforeEach(async () => {
		await env.KV.delete('keys')
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('persists one signing key pair in KV and exposes its public key as JWKS', async () => {
		const firstResponse = await workerRequest('/jwks.json')
		expect(firstResponse.status).toBe(200)

		const firstJwks = await firstResponse.json()
		expect(firstJwks.keys).toHaveLength(1)
		expect(firstJwks.keys[0]).toMatchObject({
			alg: 'RS256',
			kid: 'jwtRS256',
			kty: 'RSA',
		})

		const storedKeys = await env.KV.get('keys', { type: 'json' })
		expect(storedKeys).toMatchObject({
			privateKey: { kty: 'RSA' },
			publicKey: { kty: 'RSA' },
		})

		const secondResponse = await workerRequest('/jwks.json')
		const secondJwks = await secondResponse.json()
		expect(secondJwks).toEqual(firstJwks)
	})

	it('exchanges a Discord code and signs the returned ID token with the KV-backed key', async () => {
		const discordRequests = []

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const request = new Request(input, init)
			const url = new URL(request.url)
			discordRequests.push({
				method: request.method,
				pathname: url.pathname,
				authorization: request.headers.get('authorization'),
			})

			if (request.method === 'POST' && url.pathname === '/api/v10/oauth2/token') {
				const tokenRequest = await request.formData()
				expect(tokenRequest.get('client_id')).toBe(clientId)
				expect(tokenRequest.get('client_secret')).toBe(clientSecret)
				expect(tokenRequest.get('redirect_uri')).toBe(redirectUrl)
				expect(tokenRequest.get('code')).toBe('discord-authorization-code')
				expect(tokenRequest.get('grant_type')).toBe('authorization_code')

				return Response.json({
					access_token: 'discord-access-token',
					token_type: 'Bearer',
					expires_in: 3600,
					refresh_token: 'discord-refresh-token',
					scope: 'identify email',
				})
			}

			if (request.method === 'GET' && url.pathname === '/api/v10/users/@me') {
				return Response.json({
					id: 'discord-user-id',
					username: 'test-user',
					discriminator: '0042',
					global_name: 'Test User',
					avatar: 'avatar-hash',
					email: 'user@example.com',
					verified: true,
				})
			}

			if (request.method === 'GET' && url.pathname === '/api/v10/users/@me/guilds') {
				return Response.json([
					{ id: 'guild-one', name: 'Guild One' },
					{ id: 'guild-two', name: 'Guild Two' },
				])
			}

			if (
				request.method === 'GET'
				&& url.pathname === '/api/v10/guilds/guild-one/members/discord-user-id'
			) {
				return Response.json({
					roles: ['role-one', 'role-two'],
				})
			}

			throw new Error(`Unexpected Discord request: ${request.method} ${request.url}`)
		})

		const response = await workerRequest(
			'/token',
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					code: 'discord-authorization-code',
				}),
			},
			{
				DISCORD_GUILD_IDS: ['guild-one'],
				DISCORD_TOKEN: 'test-bot-token',
			},
		)

		expect(response.status).toBe(200)

		const tokenResponse = await response.json()
		expect(tokenResponse).toMatchObject({
			access_token: 'discord-access-token',
			token_type: 'Bearer',
			refresh_token: 'discord-refresh-token',
			scope: 'identify email',
		})
		expect(tokenResponse.id_token).toEqual(expect.any(String))

		expect(discordRequests).toEqual([
			{
				method: 'POST',
				pathname: '/api/v10/oauth2/token',
				authorization: null,
			},
			{
				method: 'GET',
				pathname: '/api/v10/users/@me',
				authorization: 'Bearer discord-access-token',
			},
			{
				method: 'GET',
				pathname: '/api/v10/users/@me/guilds',
				authorization: 'Bearer discord-access-token',
			},
			{
				method: 'GET',
				pathname: '/api/v10/guilds/guild-one/members/discord-user-id',
				authorization: 'Bot test-bot-token',
			},
		])

		const storedKeys = await env.KV.get('keys', { type: 'json' })
		expect(storedKeys).not.toBeNull()

		const jwksResponse = await workerRequest('/jwks.json')
		const jwks = await jwksResponse.json()
		const publicKey = await importJWK(jwks.keys[0], 'RS256')
		const { payload, protectedHeader } = await jwtVerify(
			tokenResponse.id_token,
			publicKey,
			{
				audience: clientId,
				issuer: 'https://cloudflare.com',
			},
		)

		expect(protectedHeader.alg).toBe('RS256')
		expect(payload).toMatchObject({
			iss: 'https://cloudflare.com',
			aud: clientId,
			id: 'discord-user-id',
			username: 'test-user',
			preferred_username: 'test-user#0042',
			global_name: 'Test User',
			name: 'Test User',
			email: 'user@example.com',
			verified: true,
			guilds: ['guild-one', 'guild-two'],
			'roles:guild-one': ['role-one', 'role-two'],
		})
		expect(payload.exp).toEqual(expect.any(Number))
	})
})
