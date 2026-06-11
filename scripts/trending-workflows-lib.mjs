import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = resolve(REPO_ROOT, '.trending-workflows');
export const CANDIDATES_FILE = resolve(DATA_DIR, 'candidates.json');
export const APPROVED_FILE = resolve(DATA_DIR, 'approved.json');
export const REPORT_FILE = resolve(DATA_DIR, 'report.html');
export const LOCAL_ENV_FILE = resolve(DATA_DIR, 'local.env');
export const IMPORT_LOG_FILE = resolve(DATA_DIR, 'import-log.json');

export function loadLocalEnv() {
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

export const TEMPLATES_HOST = (process.env.N8N_TEMPLATES_HOST ?? 'https://api.n8n.io/api/').replace(
	/\/?$/,
	'/',
);

export function localUrl() {
	return (process.env.N8N_LOCAL_URL ?? 'http://localhost:5678').replace(/\/$/, '');
}

export function localApiKey() {
	return process.env.N8N_LOCAL_API_KEY ?? '';
}

export function localEmail() {
	return process.env.N8N_EMAIL ?? '';
}

export function localPassword() {
	return process.env.N8N_PASSWORD ?? '';
}

export function getRows() {
	return Number(process.env.TRENDING_ROWS ?? 40);
}

export function getMinScore() {
	return Number(process.env.TRENDING_MIN_SCORE ?? 35);
}

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
	'lead', 'sales', 'revenue', 'customer', 'crm', 'outreach', 'invoice', 'billing',
	'prospect', 'conversion', 'chatbot', 'agent', 'automation service', 'seo', 'marketing',
	'email sequence', 'appointment', 'booking',
];

const AI_NODE_PREFIXES = ['@n8n/n8n-nodes-langchain.', 'n8n-nodes-base.openAi'];

export const TEMPLATE_CATEGORIES = [
	'AI', 'AI Chatbot', 'AI RAG', 'AI Summarization', 'Content Creation', 'CRM',
	'Crypto Trading', 'DevOps', 'Document Extraction', 'Document Ops', 'Engineering',
	'File Management', 'HR', 'Internal Wiki', 'Invoice Processing', 'IT Ops',
	'Lead Generation', 'Lead Nurturing', 'Marketing', 'Market Research', 'Miscellaneous',
	'Multimodal AI', 'Other', 'Personal Productivity', 'Project Management', 'Sales',
	'SecOps', 'Social Media', 'Support', 'Support Chatbot', 'Ticket Management',
];

function ensureDataDir() {
	if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadJson(path, fallback) {
	if (!existsSync(path)) return fallback;
	return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveJson(path, data) {
	ensureDataDir();
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

async function fetchJson(url) {
	const response = await fetch(url, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
	return response.json();
}

function keywordHits(text) {
	const lower = text.toLowerCase();
	return MONETIZATION_KEYWORDS.filter((word) => lower.includes(word)).length;
}

function scoreWorkflow(workflow, rankIndex, detail) {
	let score = 0;
	const reasons = [];
	const rankBonus = Math.max(0, 25 - rankIndex);
	score += rankBonus;
	if (rankBonus > 0) reasons.push(`trending rank #${rankIndex + 1} (+${rankBonus})`);
	const views = workflow.totalViews ?? 0;
	const viewBonus = Math.min(15, Math.round(Math.log10(views + 1) * 5));
	score += viewBonus;
	if (viewBonus > 0) reasons.push(`${views} views (+${viewBonus})`);
	for (const category of detail?.categories ?? []) {
		const bonus = MONETIZATION_CATEGORIES.get(category.name);
		if (bonus) {
			score += bonus;
			reasons.push(`${category.name} (+${bonus})`);
		}
	}
	const nodeTypes = (workflow.nodes ?? []).map((n) => n.name ?? n.type ?? '');
	const aiNodes = nodeTypes.filter((t) => AI_NODE_PREFIXES.some((p) => t.startsWith(p)));
	if (aiNodes.length > 0) {
		const aiBonus = Math.min(12, aiNodes.length * 3);
		score += aiBonus;
		reasons.push(`${aiNodes.length} AI node(s) (+${aiBonus})`);
	}
	if (workflow.user?.verified) {
		score += 5;
		reasons.push('verified creator (+5)');
	}
	const text = `${workflow.name}\n${workflow.description ?? ''}`;
	const hits = keywordHits(text);
	if (hits > 0) {
		const kwBonus = Math.min(10, hits * 2);
		score += kwBonus;
		reasons.push(`${hits} monetization keyword(s) (+${kwBonus})`);
	}
	return { score: Math.min(100, score), reasons };
}

export function resolveTopicFilter(topic) {
	const trimmed = topic?.trim();
	if (!trimmed) return null;
	const lower = trimmed.toLowerCase();
	const exact = TEMPLATE_CATEGORIES.find((c) => c.toLowerCase() === lower);
	if (exact) return { topic: trimmed, mode: 'category', category: exact, search: undefined };
	const partialMatches = TEMPLATE_CATEGORIES.filter(
		(c) => c.toLowerCase().includes(lower) || lower.includes(c.toLowerCase()),
	);
	if (partialMatches.length === 1) {
		return { topic: trimmed, mode: 'category', category: partialMatches[0], search: undefined };
	}
	if (partialMatches.length > 1) {
		const best = partialMatches.sort((a, b) => a.length - b.length)[0];
		return { topic: trimmed, mode: 'category', category: best, search: undefined };
	}
	return { topic: trimmed, mode: 'search', category: undefined, search: trimmed };
}

export function parseTopicArg(argv) {
	let topic = process.env.TRENDING_TOPIC?.trim() ?? '';
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--topic' && argv[i + 1]) topic = argv[++i].trim();
		else if (arg.startsWith('--topic=')) topic = arg.slice('--topic='.length).trim();
		else if (!arg.startsWith('--')) topic = arg.trim();
	}
	return topic;
}

function buildSearchQueryString(topicFilter, rows) {
	const params = new URLSearchParams({
		sort: 'trendingScore:desc,rank:desc',
		rows: String(rows),
		page: '1',
		price: '0',
		combineWith: 'and',
	});
	if (topicFilter?.category) params.set('category', topicFilter.category);
	if (topicFilter?.search) params.set('search', topicFilter.search);
	return params.toString();
}

async function fetchTemplateList(topicFilter, rows) {
	const query = buildSearchQueryString(topicFilter, rows);
	const url = `${TEMPLATES_HOST}templates/search?${query}`;
	const data = await fetchJson(url);
	if (!Array.isArray(data.workflows)) throw new Error('Unexpected templates/search response');
	return { ...data, requestUrl: url };
}

async function fetchTemplateDetail(id) {
	const url = `${TEMPLATES_HOST}templates/workflows/${id}`;
	const data = await fetchJson(url);
	return data.workflow ?? data;
}

async function fetchFullWorkflow(id) {
	return fetchJson(`${TEMPLATES_HOST}workflows/templates/${id}`);
}

export function escapeHtml(value) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

export function writeReport(data) {
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
<html lang="vi"><head><meta charset="utf-8" /><title>Trending workflows</title></head>
<body><h1>Trending (≥ ${data.minScore})</h1>
<p>${data.fetchedAt}${data.topic ? ` · ${escapeHtml(data.topic)}` : ''}</p>
<table border="1"><tr><th>Score</th><th>ID</th><th>Name</th><th>Views</th><th>Categories</th><th>Reasons</th></tr>${rows}</table>
</body></html>`;
	ensureDataDir();
	writeFileSync(REPORT_FILE, html);
}

export async function runFetch(topicFilter, options = {}) {
	const rows = options.rows ?? getRows();
	const minScore = options.minScore ?? getMinScore();
	const search = await fetchTemplateList(topicFilter, rows);
	const enriched = [];
	const skipped = [];

	for (const [index, workflow] of search.workflows.entries()) {
		try {
			const detail = await fetchTemplateDetail(workflow.id);
			const { score, reasons } = scoreWorkflow(workflow, index, detail);
			if (score < minScore) continue;
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
			skipped.push({ id: workflow.id, error: error.message });
		}
	}

	enriched.sort((a, b) => b.monetizationScore - a.monetizationScore);
	const payload = {
		fetchedAt: new Date().toISOString(),
		source: search.requestUrl,
		topic: topicFilter?.topic ?? null,
		topicFilter: topicFilter
			? { mode: topicFilter.mode, category: topicFilter.category ?? null, search: topicFilter.search ?? null }
			: null,
		totalFromApi: search.totalWorkflows,
		minScore,
		candidates: enriched,
	};
	saveJson(CANDIDATES_FILE, payload);
	writeReport(payload);
	return { payload, skipped, count: enriched.length };
}

export function getCandidatesData() {
	return loadJson(CANDIDATES_FILE, null);
}

export function getApprovedData() {
	return loadJson(APPROVED_FILE, { approved: [], rejected: [] });
}

export function getImportedTemplateIds() {
	const log = loadJson(IMPORT_LOG_FILE, { results: [] });
	const ids = new Set();
	for (const entry of log.results ?? []) {
		if (entry.status === 'ok' && entry.templateId != null) ids.add(Number(entry.templateId));
	}
	return ids;
}

export function getWorkflowStatus(id, approvedData, importedIds) {
	const approvedIds = new Set(approvedData.approved.map((w) => w.id));
	const rejectedIds = new Set(approvedData.rejected.map((w) => w.id));
	if (importedIds.has(id)) return 'imported';
	if (approvedIds.has(id)) return 'approved';
	if (rejectedIds.has(id)) return 'rejected';
	return 'pending';
}

export function getDashboardState(sessionUser = null) {
	const candidates = getCandidatesData();
	const approvedData = getApprovedData();
	const importLog = loadJson(IMPORT_LOG_FILE, null);
	const importedIds = getImportedTemplateIds();

	const list = (candidates?.candidates ?? []).map((w) => ({
		...w,
		status: getWorkflowStatus(w.id, approvedData, importedIds),
		importUrl: `${localUrl()}/workflows/templates/${w.id}`,
	}));

	return {
		candidates: list,
		meta: candidates
			? {
					fetchedAt: candidates.fetchedAt,
					topic: candidates.topic,
					topicFilter: candidates.topicFilter,
					minScore: candidates.minScore,
					totalFromApi: candidates.totalFromApi,
					source: candidates.source,
				}
			: null,
		approved: approvedData.approved.map((w) => ({
			...w,
			status: importedIds.has(w.id) ? 'imported' : 'approved',
			importUrl: `${localUrl()}/workflows/templates/${w.id}`,
			localUrl: w.importedLocalId ? `${localUrl()}/workflow/${w.importedLocalId}` : null,
		})),
		rejected: approvedData.rejected,
		importLog,
		stats: {
			candidates: list.length,
			pending: list.filter((w) => w.status === 'pending').length,
			approved: approvedData.approved.length,
			rejected: approvedData.rejected.length,
			imported: importedIds.size,
		},
		config: {
			localUrl: localUrl(),
			hasApiKey: Boolean(localApiKey()),
			hasLogin: Boolean(localEmail() && localPassword()),
			rows: getRows(),
			minScore: getMinScore(),
			ownerRole: OWNER_ROLE,
		},
		session: sessionUser
			? {
					authenticated: true,
					user: sessionUser,
				}
			: { authenticated: false },
		categories: TEMPLATE_CATEGORIES,
	};
}

export function approveByIds(ids) {
	const data = getCandidatesData();
	if (!data?.candidates?.length) throw new Error('No candidates. Run fetch first.');
	const byId = new Map(data.candidates.map((w) => [String(w.id), w]));
	const approved = getApprovedData();
	const approvedIds = new Set(approved.approved.map((w) => w.id));
	const rejected = approved.rejected.filter((w) => !ids.map(Number).includes(w.id));
	const added = [];

	for (const id of ids) {
		const workflow = byId.get(String(id));
		if (!workflow || approvedIds.has(workflow.id)) continue;
		approved.approved.push({ ...workflow, approvedAt: new Date().toISOString() });
		approvedIds.add(workflow.id);
		added.push(workflow.id);
	}

	approved.rejected = rejected;
	saveJson(APPROVED_FILE, { approved: approved.approved, rejected });
	return { added };
}

export function rejectById(id) {
	const data = getCandidatesData();
	const workflow = data?.candidates?.find((w) => w.id === Number(id));
	const approved = getApprovedData();
	approved.approved = approved.approved.filter((w) => w.id !== Number(id));
	if (!approved.rejected.some((w) => w.id === Number(id))) {
		approved.rejected.push({
			id: Number(id),
			name: workflow?.name ?? `Template #${id}`,
			rejectedAt: new Date().toISOString(),
		});
	}
	saveJson(APPROVED_FILE, approved);
}

export function resetReview(id) {
	const approved = getApprovedData();
	const numId = Number(id);
	approved.approved = approved.approved.filter((w) => w.id !== numId);
	approved.rejected = approved.rejected.filter((w) => w.id !== numId);
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
	if (!forPublicApi) {
		body.meta = { templateId: String(templateMeta.id), source: 'trending-workflows-import' };
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
	writeFileSync(
		LOCAL_ENV_FILE,
		[
			'# Local n8n credentials for trending-workflows import (gitignored)',
			'',
			...Object.entries(merged).map(([k, v]) => `${k}=${v}`),
			'',
		].join('\n'),
	);
}

export const OWNER_ROLE = 'global:owner';

function getCookieHeader(response) {
	if (typeof response.headers.getSetCookie === 'function') {
		return response.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; ');
	}
	const setCookie = response.headers.get('set-cookie');
	return setCookie ? setCookie.split(';')[0] : '';
}

export function isOwnerUser(user) {
	if (!user) return false;
	return user.isOwner === true || user.role === OWNER_ROLE;
}

function parseN8nErrorMessage(text, status) {
	try {
		const json = JSON.parse(text);
		if (typeof json.message === 'string') return json.message;
	} catch {
		// not JSON
	}
	return `HTTP ${status}`;
}

export async function loginToLocal(credentials) {
	const email = credentials?.email ?? localEmail();
	const password = credentials?.password ?? localPassword();
	if (!email || !password) throw new Error('Email and password required');
	const response = await fetch(`${localUrl()}/rest/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({ emailOrLdapLoginId: email, password }),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(`Đăng nhập thất bại: ${parseN8nErrorMessage(await response.text(), response.status)}`);
	}
	const payload = await response.json();
	const user = payload.data ?? payload;
	const cookie = getCookieHeader(response);
	if (!cookie) throw new Error('Login succeeded but no session cookie returned');
	return { cookie, user };
}

/** Login to local n8n and require global:owner role. */
export async function authenticateOwner({ email, password }) {
	if (!email || !password) throw new Error('Email và password là bắt buộc');
	const { cookie, user } = await loginToLocal({ email, password });
	if (!isOwnerUser(user)) {
		throw new Error(`Tài khoản "${email}" không có quyền Owner (global:owner)`);
	}
	const apiKey = await ensureLocalApiKey(cookie);
	process.env.N8N_EMAIL = email;
	process.env.N8N_PASSWORD = password;
	process.env.N8N_LOCAL_API_KEY = apiKey;
	saveLocalEnv({
		N8N_LOCAL_URL: localUrl(),
		N8N_EMAIL: email,
		N8N_PASSWORD: password,
		N8N_LOCAL_API_KEY: apiKey,
	});
	return {
		cookie,
		apiKey,
		user: {
			id: user.id,
			email: user.email,
			firstName: user.firstName,
			lastName: user.lastName,
			role: user.role ?? OWNER_ROLE,
			isOwner: true,
		},
	};
}

const API_KEY_LABEL = 'trending-workflows-import';
const API_KEY_SCOPES = ['workflow:create', 'workflow:read'];

async function probeApiKey(apiKey) {
	if (!apiKey) return 401;
	const response = await fetch(`${localUrl()}/api/v1/workflows?limit=1`, {
		headers: { Accept: 'application/json', 'X-N8N-API-KEY': apiKey },
		signal: AbortSignal.timeout(10_000),
	});
	return response.status;
}

async function listLocalApiKeys(cookie, label = API_KEY_LABEL) {
	const query = label ? `?label=${encodeURIComponent(label)}` : '';
	const response = await fetch(`${localUrl()}/rest/api-keys${query}`, {
		headers: { Accept: 'application/json', Cookie: cookie },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		throw new Error(`List API keys failed: ${response.status} ${await response.text()}`);
	}
	const payload = await response.json();
	return payload.data?.items ?? payload.items ?? [];
}

async function deleteLocalApiKey(cookie, id) {
	const response = await fetch(`${localUrl()}/rest/api-keys/${id}`, {
		method: 'DELETE',
		headers: { Accept: 'application/json', Cookie: cookie },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		throw new Error(`Delete API key failed: ${response.status} ${await response.text()}`);
	}
}

async function createLocalApiKey(cookie, label = API_KEY_LABEL) {
	const response = await fetch(`${localUrl()}/rest/api-keys`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie },
		body: JSON.stringify({
			label,
			expiresAt: null,
			scopes: API_KEY_SCOPES,
		}),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(`Create API key failed: ${response.status} ${await response.text()}`);
	}
	const payload = await response.json();
	const rawApiKey = payload.data?.rawApiKey ?? payload.rawApiKey;
	if (!rawApiKey) throw new Error('API key created but rawApiKey missing');
	return rawApiKey;
}

/** Reuse saved key when valid; otherwise rotate the labeled key. */
async function ensureLocalApiKey(cookie) {
	const saved = localApiKey();
	if (saved) {
		const status = await probeApiKey(saved);
		if (status !== 401) return saved;
	}

	const existing = await listLocalApiKeys(cookie);
	for (const key of existing) {
		await deleteLocalApiKey(cookie, key.id);
	}

	try {
		return await createLocalApiKey(cookie);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/already an entry with this name/i.test(message) && saved) {
			const retryStatus = await probeApiKey(saved);
			if (retryStatus !== 401) return saved;
		}
		throw error;
	}
}

export async function runSetup({ email, password }) {
	const result = await authenticateOwner({ email, password });
	return { ok: true, user: result.user };
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
	if (!response.ok) throw new Error(`import #${workflowMeta.id} failed: ${response.status} ${await response.text()}`);
	return response.json();
}

async function importOneWithSession(workflowMeta, cookie) {
	const full = await fetchFullWorkflow(workflowMeta.id);
	const body = stripTemplateForImport(full, workflowMeta);
	const response = await fetch(`${localUrl()}/rest/workflows`, {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/json', Cookie: cookie },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok) throw new Error(`import #${workflowMeta.id} failed: ${response.status} ${await response.text()}`);
	const payload = await response.json();
	return payload.data ?? payload;
}

async function resolveImportAuth() {
	if (localApiKey()) return { mode: 'apiKey', apiKey: localApiKey() };
	if (localEmail() && localPassword()) {
		const { cookie, user } = await loginToLocal();
		if (!isOwnerUser(user)) {
			throw new Error('Tài khoản đã lưu không có quyền Owner — đăng nhập lại bằng owner');
		}
		return { mode: 'session', cookie };
	}
	throw new Error('Chưa đăng nhập Owner. Đăng nhập trong UI hoặc chạy pnpm trending:setup');
}

function markApprovedImported(templateId, localId) {
	const approved = getApprovedData();
	for (const item of approved.approved) {
		if (item.id === templateId) {
			item.importedLocalId = localId;
			item.importedAt = new Date().toISOString();
		}
	}
	saveJson(APPROVED_FILE, approved);
}

export async function runImport() {
	const approved = getApprovedData();
	if (!approved.approved.length) throw new Error('Chưa có workflow được duyệt');
	const alreadyImported = getImportedTemplateIds();
	const auth = await resolveImportAuth();
	const results = [];

	for (const workflow of approved.approved) {
		if (alreadyImported.has(workflow.id)) {
			results.push({ templateId: workflow.id, name: workflow.name, status: 'skipped', reason: 'already imported' });
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
			markApprovedImported(workflow.id, created.id);
			alreadyImported.add(workflow.id);
		} catch (error) {
			results.push({ templateId: workflow.id, name: workflow.name, status: 'error', error: error.message });
		}
	}

	const importLog = { importedAt: new Date().toISOString(), localUrl: localUrl(), method: auth.mode, results };
	saveJson(IMPORT_LOG_FILE, importLog);
	return importLog;
}
