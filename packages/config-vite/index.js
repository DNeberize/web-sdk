// Don't convert this to a ts file, because of this https://github.com/vitejs/vite/issues/5370
import { sveltekit } from '@sveltejs/kit/vite';
import { lingui } from '@lingui/vite-plugin';
import { defineConfig } from 'vite';

const NODE_ENV = process.env.NODE_ENV;
let dev = NODE_ENV === 'development';

export default () =>
	defineConfig({
		plugins: [sveltekit(), lingui()],
		logLevel: 'info',
		// Pre-bundle the heavy deps that workspace packages import. Otherwise Vite only finds them
		// on the first page load, re-optimizes and reloads mid-load, and the game can start with
		// half its assets missing ("key ... is not found in loadedAssets").
		optimizeDeps: {
			include: [
				'lodash',
				'@lingui/core',
				'pixi-svelte > pixi.js',
				'pixi-svelte > webfontloader',
				'pixi-svelte > @esotericsoftware/spine-pixi-v8',
				'pixi-svelte > @barvynkoa/particle-emitter',
				'utils-xstate > xstate',
				'utils-sound > howler',
				'components-ui-html > utils-resize-observer > resize-observer',
			],
		},
		build: {
			assetsInlineLimit: Infinity,
			sourcemap: dev ? true : false,
			output: {
				sourcemap: dev ? true : false,
			},
		},
		css: {
			preprocessorOptions: {
				scss: {
					api: 'modern-compiler',
				},
			},
		},
	});
