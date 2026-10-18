import js from '@eslint/js';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'indexer-worker.cjs',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		files: ['**/*.{ts,cts,mts,tsx}'],
		extends: obsidianmd.configs.recommended,
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	{
		files: ['tests/**/*.mjs'],
		extends: [js.configs.recommended],
		languageOptions: {
			globals: globals.node,
		},
	},
);
