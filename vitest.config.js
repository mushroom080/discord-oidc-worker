import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: {
				configPath: './wrangler.toml',
			},
			miniflare: {
				// The bundled local workerd currently supports compatibility dates through 2026-07-22.
				compatibilityDate: '2026-07-22',
				bindings: {
					DISCORD_CLIENT_ID: 'test-discord-client',
					DISCORD_CLIENT_SECRET: 'test-discord-secret',
					CLOUDFLARE_ACCESS_REDIRECT_URL: 'https://access.example.com/callback',
					DISCORD_GUILD_IDS: '[]',
				},
				kvNamespaces: ['KV'],
			},
		}),
	],
	test: {
		include: ['test/**/*.test.js'],
	},
})
