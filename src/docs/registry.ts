/**
 * Library Registry
 *
 * Maps package names to their documentation sources across providers.
 * This enables automatic lookup of Context7 IDs, llms.txt URLs, and DevDocs slugs.
 */

import type { LibrarySource } from "./types.js";

// ============================================================================
// Library Sources Mapping
// ============================================================================

/**
 * Maps common package names to their documentation sources.
 * Keys are lowercase package names as they appear in package.json, requirements.txt, etc.
 */
export const LIBRARY_SOURCES: Record<string, LibrarySource> = {
	// ─────────────────────────────────────────────────────────────────────────
	// JavaScript/TypeScript - Frontend Frameworks
	// ─────────────────────────────────────────────────────────────────────────
	react: {
		context7: "facebook/react",
		devdocs: "react",
	},
	"react-dom": {
		context7: "facebook/react",
		devdocs: "react",
	},
	vue: {
		context7: "vuejs/core",
		llmsTxt: "https://vuejs.org/llms-full.txt",
		devdocs: "vue~3",
	},
	"vue-router": {
		context7: "vuejs/router",
	},
	pinia: {
		context7: "vuejs/pinia",
	},
	angular: {
		context7: "angular/angular",
		devdocs: "angular",
	},
	"@angular/core": {
		context7: "angular/angular",
		devdocs: "angular",
	},
	svelte: {
		context7: "sveltejs/svelte",
		devdocs: "svelte",
	},
	"@sveltejs/kit": {
		context7: "sveltejs/kit",
	},
	solid: {
		context7: "solidjs/solid",
	},
	"solid-js": {
		context7: "solidjs/solid",
	},
	preact: {
		context7: "preactjs/preact",
	},
	lit: {
		context7: "lit/lit",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// JavaScript/TypeScript - Meta-Frameworks
	// ─────────────────────────────────────────────────────────────────────────
	next: {
		context7: "vercel/next.js",
		devdocs: "next.js",
	},
	nuxt: {
		context7: "nuxt/nuxt",
		llmsTxt: "https://nuxt.com/llms-full.txt",
	},
	gatsby: {
		context7: "gatsbyjs/gatsby",
	},
	remix: {
		context7: "remix-run/remix",
	},
	"@remix-run/react": {
		context7: "remix-run/remix",
	},
	astro: {
		context7: "withastro/astro",
	},
	vite: {
		context7: "vitejs/vite",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// JavaScript/TypeScript - Backend
	// ─────────────────────────────────────────────────────────────────────────
	express: {
		context7: "expressjs/express",
		devdocs: "express",
	},
	fastify: {
		context7: "fastify/fastify",
	},
	hono: {
		context7: "honojs/hono",
	},
	koa: {
		context7: "koajs/koa",
	},
	nestjs: {
		context7: "nestjs/nest",
	},
	"@nestjs/core": {
		context7: "nestjs/nest",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// JavaScript/TypeScript - State Management
	// ─────────────────────────────────────────────────────────────────────────
	redux: {
		context7: "reduxjs/redux",
		devdocs: "redux",
	},
	"@reduxjs/toolkit": {
		context7: "reduxjs/redux-toolkit",
	},
	zustand: {
		context7: "pmndrs/zustand",
	},
	jotai: {
		context7: "pmndrs/jotai",
	},
	recoil: {
		context7: "facebookexperimental/Recoil",
	},
	mobx: {
		context7: "mobxjs/mobx",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// JavaScript/TypeScript - Data Fetching & APIs
	// ─────────────────────────────────────────────────────────────────────────
	axios: {
		context7: "axios/axios",
	},
	"@tanstack/react-query": {
		context7: "TanStack/query",
	},
	"react-query": {
		context7: "TanStack/query",
	},
	swr: {
		context7: "vercel/swr",
	},
	trpc: {
		context7: "trpc/trpc",
	},
	"@trpc/server": {
		context7: "trpc/trpc",
	},
	graphql: {
		context7: "graphql/graphql-js",
		devdocs: "graphql",
	},
	"@apollo/client": {
		context7: "apollographql/apollo-client",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// JavaScript/TypeScript - Database & ORM
	// ─────────────────────────────────────────────────────────────────────────
	prisma: {
		context7: "prisma/prisma",
	},
	"@prisma/client": {
		context7: "prisma/prisma",
	},
	drizzle: {
		context7: "drizzle-team/drizzle-orm",
	},
	"drizzle-orm": {
		context7: "drizzle-team/drizzle-orm",
	},
	typeorm: {
		context7: "typeorm/typeorm",
	},
	mongoose: {
		context7: "Automattic/mongoose",
		devdocs: "mongoose",
	},
	sequelize: {
		context7: "sequelize/sequelize",
	},
	knex: {
		context7: "knex/knex",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// JavaScript/TypeScript - Testing
	// ─────────────────────────────────────────────────────────────────────────
	jest: {
		context7: "jestjs/jest",
		devdocs: "jest",
	},
	vitest: {
		context7: "vitest-dev/vitest",
	},
	playwright: {
		context7: "microsoft/playwright",
	},
	"@playwright/test": {
		context7: "microsoft/playwright",
	},
	cypress: {
		context7: "cypress-io/cypress",
	},
	"@testing-library/react": {
		context7: "testing-library/react-testing-library",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// JavaScript/TypeScript - Styling
	// ─────────────────────────────────────────────────────────────────────────
	tailwindcss: {
		context7: "tailwindlabs/tailwindcss",
	},
	"styled-components": {
		context7: "styled-components/styled-components",
	},
	"@emotion/react": {
		context7: "emotion-js/emotion",
	},
	"@chakra-ui/react": {
		context7: "chakra-ui/chakra-ui",
	},
	"@mui/material": {
		context7: "mui/material-ui",
	},
	"@radix-ui/react-primitive": {
		context7: "radix-ui/primitives",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// JavaScript/TypeScript - Build Tools
	// ─────────────────────────────────────────────────────────────────────────
	webpack: {
		context7: "webpack/webpack",
		devdocs: "webpack",
	},
	esbuild: {
		context7: "evanw/esbuild",
	},
	rollup: {
		context7: "rollup/rollup",
	},
	turbo: {
		context7: "vercel/turbo",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// JavaScript/TypeScript - Utilities
	// ─────────────────────────────────────────────────────────────────────────
	lodash: {
		context7: "lodash/lodash",
		devdocs: "lodash~4",
	},
	"date-fns": {
		context7: "date-fns/date-fns",
	},
	dayjs: {
		context7: "iamkun/dayjs",
	},
	zod: {
		context7: "colinhacks/zod",
	},
	yup: {
		context7: "jquense/yup",
	},
	rxjs: {
		context7: "ReactiveX/rxjs",
		devdocs: "rxjs",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Python - Web Frameworks
	// ─────────────────────────────────────────────────────────────────────────
	django: {
		context7: "django/django",
		devdocs: "django~5.0",
	},
	flask: {
		context7: "pallets/flask",
		devdocs: "flask~3.0",
	},
	fastapi: {
		context7: "tiangolo/fastapi",
	},
	starlette: {
		context7: "encode/starlette",
	},
	tornado: {
		context7: "tornadoweb/tornado",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Python - AI/ML
	// ─────────────────────────────────────────────────────────────────────────
	langchain: {
		context7: "langchain-ai/langchain",
		llmsTxt: "https://langchain-ai.github.io/langgraph/llms-txt-overview/",
	},
	openai: {
		context7: "openai/openai-python",
	},
	anthropic: {
		context7: "anthropics/anthropic-sdk-python",
	},
	transformers: {
		context7: "huggingface/transformers",
	},
	torch: {
		context7: "pytorch/pytorch",
		devdocs: "pytorch",
	},
	pytorch: {
		context7: "pytorch/pytorch",
		devdocs: "pytorch",
	},
	tensorflow: {
		context7: "tensorflow/tensorflow",
		devdocs: "tensorflow~2.16",
	},
	numpy: {
		context7: "numpy/numpy",
		devdocs: "numpy~2.0",
	},
	pandas: {
		context7: "pandas-dev/pandas",
		devdocs: "pandas~2",
	},
	scikit_learn: {
		context7: "scikit-learn/scikit-learn",
		devdocs: "scikit_learn",
	},
	"scikit-learn": {
		context7: "scikit-learn/scikit-learn",
		devdocs: "scikit_learn",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Python - Database
	// ─────────────────────────────────────────────────────────────────────────
	sqlalchemy: {
		context7: "sqlalchemy/sqlalchemy",
		devdocs: "sqlalchemy~2.0",
	},
	psycopg2: {
		context7: "psycopg/psycopg2",
	},
	redis: {
		context7: "redis/redis-py",
	},
	celery: {
		context7: "celery/celery",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Python - Testing
	// ─────────────────────────────────────────────────────────────────────────
	pytest: {
		context7: "pytest-dev/pytest",
		devdocs: "pytest",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Go
	// ─────────────────────────────────────────────────────────────────────────
	gin: {
		context7: "gin-gonic/gin",
	},
	"github.com/gin-gonic/gin": {
		context7: "gin-gonic/gin",
	},
	echo: {
		context7: "labstack/echo",
	},
	fiber: {
		context7: "gofiber/fiber",
	},
	gorm: {
		context7: "go-gorm/gorm",
	},
	"github.com/go-gorm/gorm": {
		context7: "go-gorm/gorm",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Rust
	// ─────────────────────────────────────────────────────────────────────────
	tokio: {
		context7: "tokio-rs/tokio",
	},
	actix: {
		context7: "actix/actix-web",
	},
	"actix-web": {
		context7: "actix/actix-web",
	},
	axum: {
		context7: "tokio-rs/axum",
	},
	serde: {
		context7: "serde-rs/serde",
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Cloud & Infrastructure
	// ─────────────────────────────────────────────────────────────────────────
	"@aws-sdk/client-s3": {
		context7: "aws/aws-sdk-js-v3",
	},
	"@azure/storage-blob": {
		context7: "Azure/azure-sdk-for-js",
	},
	"@google-cloud/storage": {
		context7: "googleapis/google-cloud-node",
	},
	docker: {
		devdocs: "docker",
	},
	kubernetes: {
		devdocs: "kubernetes",
	},
	terraform: {
		devdocs: "terraform",
	},
};

// ============================================================================
// Registry Utilities
// ============================================================================

/**
 * Get all registered library names
 */
export function getRegisteredLibraries(): string[] {
	return Object.keys(LIBRARY_SOURCES);
}

/**
 * Check if a library is in the registry
 */
export function isRegisteredLibrary(library: string): boolean {
	return library.toLowerCase() in LIBRARY_SOURCES;
}

/**
 * Get source info for a library
 */
export function getLibrarySource(library: string): LibrarySource | undefined {
	return LIBRARY_SOURCES[library.toLowerCase()];
}

/**
 * Add or update a library source at runtime
 */
export function registerLibrarySource(
	library: string,
	source: LibrarySource,
): void {
	LIBRARY_SOURCES[library.toLowerCase()] = source;
}
