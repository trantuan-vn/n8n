#!/usr/bin/env node
/**
 * Fetch trending n8n workflow templates, rank by monetization potential,
 * let admin review, then import approved workflows into a local instance.
 *
 * Docs: scripts/trending-workflows.md
 *
 * Usage:
 *   pnpm trending:fetch              # fetch + score + save candidates
 *   pnpm trending:list                 # print ranked list
 *   pnpm trending:review               # interactive y/n/s review
 *   pnpm trending:approve 5962 1234    # approve by template id
 *   pnpm trending:import               # import approved into localhost
 *   pnpm trending:report               # openable HTML summary
 *
 * Env:
 *   N8N_TEMPLATES_HOST   default https://api.n8n.io/api/
 *   N8N_LOCAL_URL        default http://localhost:5678
 *   N8N_LOCAL_API_KEY    required for import (Settings → API)
 *   TRENDING_ROWS        default 40
 *   TRENDING_MIN_SCORE   default 35 (0-100)
 */
import { createInterface } from 'node:readline/promises';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(REPO_ROOT, '.trending-workflows');
const CANDIDATES_FILE = resolve(DATA_DIR, 'candidates.json');
const APPROVED_FILE = resolve(DATA_DIR, 'approved.json');
const REPORT_FILE = resolve(DATA_DIR, 'report.html');
const LOCAL_ENV_FILE = resolve(DATA_DIR, 'local.env');

function loadLocalEnv() {
	if (!existsSync(LOCAL_ENV_FILE)) return;
	for (const line of readFileSync(LOCAL_ENV_FILE, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq);
		const value = trimmed.slice(eq + 1);
		if (!(key in process.env)) process.env[key] = value;
	}
}

loadLocalEnv();

const TEMPLATES_HOST = (process.env.N8N_TEMPLATES_HOST ?? 'https://api.n8n.io/api/').replace(
	/\/?$/,
	'/',
);
function localUrl() {
	return (process.env.N8N_LOCAL_URL ?? 'http://localhost:5678').replace(/\/$/, '');
}

function localApiKey() {
	return process.env.N8N_LOCAL_API_KEY ?? '';
}

function localEmail() {
	return process.env.N8N_EMAIL ?? '';
}

function localPassword() {
	return process.env.N8N_PASSWORD ?? '';
}

const ROWS = Number(process.env.TRENDING_ROWS ?? 40);
const MIN_SCORE = Number(process.env.TRENDING_MIN_SCORE ?? 35);

/** Categories that usually map to billable automation services. */
const MONETIZATION_CATEGORIES = new Map([
	['Sales', 18],
	['Lead Generation', 20],
	['Lead Nurturing', 16],
	['CRM', 18],
	['Marketing', 14],
	['Invoice Processing', 16],
	['Support Chatbot', 15],
	['AI Chatbot', 17],
	['AI RAG', 14],
	['Content Creation', 12],
	['Market Research', 12],
	['HR', 10],
	['Support', 10],
	['Ticket Management', 11],
	['Document Extraction', 13],
	['Social Media', 11],
]);

const MONETIZATION_KEYWORDS = [
	'lead',
	'sales',
	'revenue',
	'customer',
	'crm',
	'outreach',
	'invoice',
	'billing',
	'prospect',
	'conversion',
	'chatbot',
	'agent',
	'automation service',
	'seo',
	'marketing',
	'email sequence',
	'appointment',
	'booking',
];

const AI_NODE_PREFIXES = [
	'@n8n/n8n-nodes-langchain.',
	'n8n-nodes-base.openAi',
];

function ensureDataDir() {
	if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(path, fallback) {
	if (!existsSync(path)) return fallback;
	return JSON.parse(readFileSync(path, 'utf8'));
}

function saveJson(path, data) {
	ensureDataDir();
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

async function fetchJson(url) {
	const response = await fetch(url, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for ${url}`);
	}
	return response.json();
}

function keywordHits(text) {
	const lower = text.toLowerCase();
	return MONETIZATION_KEYWORDS.filter((word) => lower.includes(word)).length;
}

function scoreWorkflow(workflow, rankIndex, detail) {
	let score = 0;
	const reasons = [];

	// Trending position (top of list = higher)
	const rankBonus = Math.max(0, 25 - rankIndex);
	score += rankBonus;
	if (rankBonus > 0) reasons.push(`trending rank #${rankIndex + 1} (+${rankBonus})`);

	// Views (log scale, cap 15)
	const views = workflow.totalViews ?? 0;
	const viewBonus = Math.min(15, Math.round(Math.log10(views + 1) * 5));
	score += viewBonus;
	if (viewBonus > 0) reasons.push(`${views} views (+${viewBonus})`);

	// Categories from detail fetch
	for (const category of detail?.categories ?? []) {
		const bonus = MONETIZATION_CATEGORIES.get(category.name);
		if (bonus) {
			score += bonus;
			reasons.push(`${category.name} (+${bonus})`);
		}
	}

	// Node-based signals
	const nodeTypes = (workflow.nodes ?? []).map((n) => n.name ?? n.type ?? '');
	const aiNodes = nodeTypes.filter((t) => AI_NODE_PREFIXES.some((p) => t.startsWith(p)));
	if (aiNodes.length > 0) {
		const aiBonus = Math.min(12, aiNodes.length * 3);
		score += aiBonus;
		reasons.push(`${aiNodes.length} AI node(s) (+${aiBonus})`);
	}

	// Verified creator
	if (workflow.user?.verified) {
		score += 5;
		reasons.push('verified creator (+5)');
	}

	// Keyword signals
	const text = `${workflow.name}\n${workflow.description ?? ''}`;
	const hits = keywordHits(text);
	if (hits > 0) {
		const kwBonus = Math.min(10, hits * 2);
		score += kwBonus;
		reasons.push(`${hits} monetization keyword(s) (+${kwBonus})`);
	}

	return { score: Math.min(100, score), reasons };
}

async function fetchTemplateList(page = 1) {
	const params = new URLSearchParams({
		sort: 'trendingScore:desc,rank:desc',
		rows: String(ROWS),
		page: String(page),
		price: '0',
		combineWith: 'and',
	});
	const url = `${TEMPLATES_HOST}templates/search?${params}`;
	const data = await fetchJson(url);
	if (!Array.isArray(data.workflows)) {
		throw new Error('Unexpected templates/search response');
	}
	return data;
}

async function fetchTemplateDetail(id) {
	const url = `${TEMPLATES_HOST}templates/workflows/${id}`;
	const data = await fetchJson(url);
	return data.workflow ?? data;
}

async function fetchFullWorkflow(id) {
	const url = `${TEMPLATES_HOST}workflows/templates/${id}`;
	return fetchJson(url);
}

async function cmdFetch() {
	console.log(`Fetching top ${ROWS} trending templates from ${TEMPLATES_HOST}...`);
	const search = await fetchTemplateList();
	const enriched = [];

	for (const [index, workflow] of search.workflows.entries()) {
		try {
			const detail = await fetchTemplateDetail(workflow.id);
			const { score, reasons } = scoreWorkflow(workflow, index, detail);
			if (score < MIN_SCORE) continue;

			enriched.push({
				id: workflow.id,
				name: workflow.name,
				description: (workflow.description ?? '').slice(0, 280),
				totalViews: workflow.totalViews ?? 0,
				categories: (detail.categories ?? []).map((c) => c.name),
				author: workflow.user?.username ?? 'unknown',
				verified: Boolean(workflow.user?.verified),
				templateUrl: `https://n8n.io/workflows/${workflow.id}`,
				monetizationScore: score,
				reasons,
				fetchedAt: new Date().toISOString(),
			});
		} catch (error) {
			console.warn(`  skip #${workflow.id}: ${error.message}`);
		}
	}

	enriched.sort((a, b) => b.monetizationScore - a.monetizationScore);

	const payload = {
		fetchedAt: new Date().toISOString(),
		source: `${TEMPLATES_HOST}templates/search`,
		totalFromApi: search.totalWorkflows,
		minScore: MIN_SCORE,
		candidates: enriched,
	};

	saveJson(CANDIDATES_FILE, payload);
	writeReport(payload);
	console.log(`Saved ${enriched.length} candidates (score >= ${MIN_SCORE})`);
	console.log(`  ${CANDIDATES_FILE}`);
	console.log(`  ${REPORT_FILE}`);
}

function getCandidates() {
	const data = loadJson(CANDIDATES_FILE, null);
	if (!data?.candidates?.length) {
		throw new Error(`No candidates. Run: pnpm trending:fetch`);
	}
	return data;
}

function cmdList() {
	const data = getCandidates();
	console.log(`\nTrending workflows — monetization score >= ${data.minScore}\n`);
	for (const [i, w] of data.candidates.entries()) {
		console.log(
			`${String(i + 1).padStart(2)}. [${w.monetizationScore}] #${w.id} ${w.name}`,
		);
		console.log(`    views: ${w.totalViews} | categories: ${w.categories.join(', ') || '-'}`);
		console.log(`    ${w.templateUrl}`);
		console.log(`    ${w.reasons.join('; ')}`);
		console.log('');
	}
}

async function cmdReview() {
	const data = getCandidates();
	const approved = loadJson(APPROVED_FILE, { approved: [], rejected: [] });
	const approvedIds = new Set(approved.approved.map((w) => w.id));
	const rejectedIds = new Set(approved.rejected.map((w) => w.id));

	const rl = createInterface({ input: process.stdin, output: process.stdout });

	console.log('Review: y=approve, n=reject, s=skip, q=quit\n');

	for (const w of data.candidates) {
		if (approvedIds.has(w.id) || rejectedIds.has(w.id)) continue;

		console.log(`\n[${w.monetizationScore}] #${w.id} — ${w.name}`);
		console.log(`views: ${w.totalViews} | ${w.categories.join(', ')}`);
		console.log(w.description.slice(0, 200) + (w.description.length > 200 ? '…' : ''));
		console.log(w.templateUrl);

		const answer = (await rl.question('Approve? [y/n/s/q]: ')).trim().toLowerCase();
		if (answer === 'q') break;
		if (answer === 's') continue;
		if (answer === 'y') {
			approved.approved.push({ ...w, approvedAt: new Date().toISOString() });
			approvedIds.add(w.id);
		} else if (answer === 'n') {
			approved.rejected.push({ id: w.id, name: w.name, rejectedAt: new Date().toISOString() });
			rejectedIds.add(w.id);
		}
	}

	rl.close();
	saveJson(APPROVED_FILE, approved);
	console.log(`\nApproved: ${approved.approved.length} | Rejected: ${approved.rejected.length}`);
	console.log(`  ${APPROVED_FILE}`);
}

function cmdApprove(ids) {
	if (!ids.length) {
		console.error('Usage: node scripts/trending-workflows.mjs approve <id> [id...]');
		process.exit(2);
	}

	const data = getCandidates();
	const byId = new Map(data.candidates.map((w) => [String(w.id), w]));
	const approved = loadJson(APPROVED_FILE, { approved: [], rejected: [] });
	const approvedIds = new Set(approved.approved.map((w) => w.id));

	for (const id of ids) {
		const workflow = byId.get(String(id));
		if (!workflow) {
			console.warn(`  #${id} not in candidates — run fetch first or lower MIN_SCORE`);
			continue;
		}
		if (approvedIds.has(workflow.id)) {
			console.log(`  #${id} already approved`);
			continue;
		}
		approved.approved.push({ ...workflow, approvedAt: new Date().toISOString() });
		approvedIds.add(workflow.id);
		console.log(`  approved #${id} — ${workflow.name}`);
	}

	saveJson(APPROVED_FILE, approved);
}

function stripTemplateForImport(templatePayload, templateMeta, { forPublicApi = false } = {}) {
	const { workflow } = templatePayload;
	const body = {
		name: templateMeta.name,
		nodes: workflow.nodes,
		connections: workflow.connections,
		settings: workflow.settings ?? {},
		pinData: workflow.pinData ?? {},
	};

	// Public API rejects read-only fields (active, meta) on create.
	if (!forPublicApi) {
		body.meta = {
			templateId: String(templateMeta.id),
			source: 'trending-workflows-import',
		};
	}

	return body;
}

function saveLocalEnv(values) {
	ensureDataDir();
	const existing = existsSync(LOCAL_ENV_FILE)
		? Object.fromEntries(
				readFileSync(LOCAL_ENV_FILE, 'utf8')
					.split('\n')
					.filter((line) => line.includes('=') && !line.trim().startsWith('#'))
					.map((line) => {
						const eq = line.indexOf('=');
						return [line.slice(0, eq), line.slice(eq + 1)];
					}),
			)
		: {};
	const merged = { ...existing, ...values };
	const lines = [
		'# Local n8n credentials for trending-workflows import (gitignored)',
		'',
		...Object.entries(merged).map(([key, value]) => `${key}=${value}`),
		'',
	];
	writeFileSync(LOCAL_ENV_FILE, lines.join('\n'));
}

function getCookieHeader(response) {
	if (typeof response.headers.getSetCookie === 'function') {
		return response.headers
			.getSetCookie()
			.map((cookie) => cookie.split(';')[0])
			.join('; ');
	}
	const setCookie = response.headers.get('set-cookie');
	return setCookie ? setCookie.split(';')[0] : '';
}

async function loginToLocal(credentials) {
	const email = credentials?.email ?? localEmail();
	const password = credentials?.password ?? localPassword();
	if (!email || !password) {
		throw new Error('Set N8N_EMAIL and N8N_PASSWORD (or run: pnpm trending:setup)');
	}

	const response = await fetch(`${localUrl()}/rest/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({ emailOrLdapLoginId: email, password }),
		signal: AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		throw new Error(`Login failed: ${response.status} ${await response.text()}`);
	}

	const cookie = getCookieHeader(response);
	if (!cookie) {
		throw new Error('Login succeeded but no session cookie returned');
	}

	return cookie;
}

async function createLocalApiKey(cookie) {
	const response = await fetch(`${localUrl()}/rest/api-keys`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			Cookie: cookie,
		},
		body: JSON.stringify({
			label: 'trending-workflows-import',
			expiresAt: null,
			scopes: ['workflow:create', 'workflow:read'],
		}),
		signal: AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		throw new Error(`Create API key failed: ${response.status} ${await response.text()}`);
	}

	const payload = await response.json();
	const rawApiKey = payload.data?.rawApiKey ?? payload.rawApiKey;
	if (!rawApiKey) {
		throw new Error('API key created but rawApiKey missing in response');
	}
	return rawApiKey;
}

async function cmdSetup() {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const email = localEmail() || (await rl.question(`Email (${localUrl()}): `)).trim();
	const password = localPassword() || (await rl.question('Password: ')).trim();
	rl.close();

	if (!email || !password) {
		console.error('Email and password are required.');
		process.exit(1);
	}

	process.env.N8N_EMAIL = email;
	process.env.N8N_PASSWORD = password;

	console.log(`Logging in to ${localUrl()}...`);
	const cookie = await loginToLocal({ email, password });
	console.log('Creating API key...');
	const apiKey = await createLocalApiKey(cookie);

	saveLocalEnv({
		N8N_LOCAL_URL: localUrl(),
		N8N_EMAIL: email,
		N8N_PASSWORD: password,
		N8N_LOCAL_API_KEY: apiKey,
	});

	console.log(`Saved credentials → ${LOCAL_ENV_FILE}`);
	console.log('Next: pnpm trending:import');
}

function cmdOpen() {
	const approved = loadJson(APPROVED_FILE, null);
	if (!approved?.approved?.length) {
		console.error('Nothing approved yet.');
		process.exit(1);
	}

	console.log(`Open these URLs in browser (must be logged in to ${localUrl()}):\n`);
	for (const workflow of approved.approved) {
		const url = `${localUrl()}/workflows/templates/${workflow.id}`;
		console.log(`  #${workflow.id} ${workflow.name}`);
		console.log(`  ${url}\n`);
	}
	console.log('Tip: n8n will create the workflow automatically when the page loads.');
}

async function importOneWithApiKey(workflowMeta, apiKey) {
	const full = await fetchFullWorkflow(workflowMeta.id);
	const body = stripTemplateForImport(full, workflowMeta, { forPublicApi: true });

	const response = await fetch(`${localUrl()}/api/v1/workflows`, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			'X-N8N-API-KEY': apiKey,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`import #${workflowMeta.id} failed: ${response.status} ${text}`);
	}

	return response.json();
}

async function importOneWithSession(workflowMeta, cookie) {
	const full = await fetchFullWorkflow(workflowMeta.id);
	const body = stripTemplateForImport(full, workflowMeta);

	const response = await fetch(`${localUrl()}/rest/workflows`, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			Cookie: cookie,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`import #${workflowMeta.id} failed: ${response.status} ${text}`);
	}

	const payload = await response.json();
	return payload.data ?? payload;
}

async function resolveImportAuth() {
	if (localApiKey()) {
		return { mode: 'apiKey', apiKey: localApiKey() };
	}

	if (localEmail() && localPassword()) {
		return { mode: 'session', cookie: await loginToLocal() };
	}

	console.error(`No credentials found. Choose one:

  A) Easiest (already logged in browser):
     pnpm trending:open
     → open the printed URL in browser

  B) One-time CLI setup (auto-creates API key):
     pnpm trending:setup

  C) Manual API key:
     Settings → n8n API → Create API key
     echo 'N8N_LOCAL_API_KEY=...' >> .trending-workflows/local.env
`);
	process.exit(1);
}

function getImportedTemplateIds() {
	const log = loadJson(resolve(DATA_DIR, 'import-log.json'), { results: [] });
	const ids = new Set();
	for (const entry of log.results ?? []) {
		if (entry.status === 'ok' && entry.templateId != null) {
			ids.add(Number(entry.templateId));
		}
	}
	return ids;
}

function markApprovedImported(templateId, localId) {
	const approved = loadJson(APPROVED_FILE, { approved: [], rejected: [] });
	for (const item of approved.approved) {
		if (item.id === templateId) {
			item.importedLocalId = localId;
			item.importedAt = new Date().toISOString();
		}
	}
	saveJson(APPROVED_FILE, approved);
}

async function cmdImport() {
	const approved = loadJson(APPROVED_FILE, null);
	if (!approved?.approved?.length) {
		console.error('Nothing approved. Run: pnpm trending:review or pnpm trending:approve <id>');
		process.exit(1);
	}

	const alreadyImported = getImportedTemplateIds();
	const auth = await resolveImportAuth();
	console.log(
		`Importing ${approved.approved.length} workflow(s) → ${localUrl()} (${auth.mode})\n`,
	);
	const results = [];

	for (const workflow of approved.approved) {
		if (alreadyImported.has(workflow.id)) {
			console.log(`  ↷ #${workflow.id} already imported — skip (delete duplicate in UI if needed)`);
			continue;
		}

		try {
			const created =
				auth.mode === 'apiKey'
					? await importOneWithApiKey(workflow, auth.apiKey)
					: await importOneWithSession(workflow, auth.cookie);
			results.push({
				templateId: workflow.id,
				localId: created.id,
				name: created.name,
				url: `${localUrl()}/workflow/${created.id}`,
				status: 'ok',
			});
			console.log(`  ✓ #${workflow.id} → ${created.id}  ${created.name}`);
			markApprovedImported(workflow.id, created.id);
			alreadyImported.add(workflow.id);
		} catch (error) {
			results.push({
				templateId: workflow.id,
				name: workflow.name,
				status: 'error',
				error: error.message,
			});
			console.error(`  ✗ #${workflow.id}: ${error.message}`);
		}
	}

	const importLog = {
		importedAt: new Date().toISOString(),
		localUrl: localUrl(),
		method: auth.mode,
		results,
	};
	saveJson(resolve(DATA_DIR, 'import-log.json'), importLog);
	console.log(`\nLog: ${resolve(DATA_DIR, 'import-log.json')}`);
}

function writeReport(data) {
	const rows = data.candidates
		.map(
			(w) => `
    <tr>
      <td>${w.monetizationScore}</td>
      <td><a href="${w.templateUrl}" target="_blank">#${w.id}</a></td>
      <td>${escapeHtml(w.name)}</td>
      <td>${w.totalViews}</td>
      <td>${escapeHtml(w.categories.join(', '))}</td>
      <td>${escapeHtml(w.reasons.join('; '))}</td>
    </tr>`,
		)
		.join('');

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Trending n8n workflows — monetization candidates</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 0.5rem 0.75rem; text-align: left; vertical-align: top; }
    th { background: #f5f5f5; }
    tr:nth-child(even) { background: #fafafa; }
  </style>
</head>
<body>
  <h1>Trending workflows (monetization score ≥ ${data.minScore})</h1>
  <p>Fetched: ${data.fetchedAt} · Source: ${escapeHtml(data.source)}</p>
  <p>Approve via CLI: <code>pnpm trending:approve &lt;id&gt;</code> then <code>pnpm trending:import</code></p>
  <table>
    <thead>
      <tr><th>Score</th><th>ID</th><th>Name</th><th>Views</th><th>Categories</th><th>Reasons</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;

	ensureDataDir();
	writeFileSync(REPORT_FILE, html);
}

function escapeHtml(value) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

function cmdReport() {
	const data = loadJson(CANDIDATES_FILE, null);
	if (!data) {
		console.error('No report data. Run: pnpm trending:fetch');
		process.exit(1);
	}
	writeReport(data);
	console.log(REPORT_FILE);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
	case 'fetch':
		await cmdFetch();
		break;
	case 'list':
		cmdList();
		break;
	case 'review':
		await cmdReview();
		break;
	case 'approve':
		cmdApprove(args);
		break;
	case 'import':
		await cmdImport();
		break;
	case 'setup':
		await cmdSetup();
		break;
	case 'open':
		cmdOpen();
		break;
	case 'report':
		cmdReport();
		break;
	default:
		console.log(`Usage:
  pnpm trending:fetch
  pnpm trending:list
  pnpm trending:review
  pnpm trending:approve <id> [id...]
  pnpm trending:setup
  pnpm trending:open
  pnpm trending:import
  pnpm trending:report`);
		process.exit(command ? 1 : 0);
}
