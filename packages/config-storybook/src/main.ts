import type { StorybookConfig } from '@storybook/sveltekit';

const config: StorybookConfig = {
	stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|ts|svelte)'],
	addons: ['@storybook/addon-svelte-csf', '@storybook/addon-docs'],
	framework: {
		name: '@storybook/sveltekit',
		options: {},
	},
	staticDirs: ['../static'],
	// @storybook/svelte-vite always adds a docgen plugin that builds a TypeScript program
	// per .svelte file (including every workspace package). On Windows this pins the
	// dev server at 100% CPU in fs.stat/realpath and the preview times out. Prop tables
	// in the Docs tab are the only thing lost.
	viteFinal: async (viteConfig) => {
		const DOCGEN = 'storybook:svelte-docgen-plugin';
		const strip = (plugins: unknown[]): unknown[] =>
			plugins
				.filter((p) => !(p && typeof p === 'object' && 'name' in p && p.name === DOCGEN))
				.map((p) => (Array.isArray(p) ? strip(p) : p));
		return { ...viteConfig, plugins: strip(viteConfig.plugins ?? []) as typeof viteConfig.plugins };
	},
};

export default config;
