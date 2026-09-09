import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Static adapter + fallback: this whole app is client-only (ssr = false
			// in +layout.js — Firebase Auth/Firestore need the browser), so it builds
			// to a plain SPA: one index.html shell that client-side routing takes
			// over from, same deploy model as the original Vite + React app.
			adapter: adapter({
				fallback: 'index.html'
			})
		})
	]
});
