#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	authenticateOwner,
	getDashboardState,
	runFetch,
	resolveTopicFilter,
	approveByIds,
	rejectById,
	resetReview,
	runImport,
	localUrl,
} from './trending-workflows-lib.mjs';

const PORT = Number(process.env.TRENDING_UI_PORT ?? 3847);
const UI_HTML = resolve(dirname(fileURLToPath(import.meta.url)), 'trending-workflows-ui.html');
const SESSION_COOKIE = 'trending_admin_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** @type {Map<string, { user: object; cookie: string; expiresAt: number }>} */
const sessions = new Map();

function sendJson(res, status, data, extraHeaders = {}) {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
	res.end(JSON.stringify(data));
}

function parseCookies(req) {
	const header = req.headers.cookie ?? '';
	const out = {};
	for (const part of header.split(';')) {
		const [k, ...rest] = part.trim().split('=');
		if (k) out[k] = decodeURIComponent(rest.join('='));
	}
	return out;
}

function getSession(req) {
	const token = parseCookies(req)[SESSION_COOKIE];
	if (!token) return null;
	const session = sessions.get(token);
	if (!session || session.expiresAt < Date.now()) {
		if (token) sessions.delete(token);
		return null;
	}
	return { token, ...session };
}

function setSessionCookie(res, token) {
	const maxAge = Math.floor(SESSION_TTL_MS / 1000);
	res.setHeader(
		'Set-Cookie',
		`${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
	);
}

function clearSessionCookie(res) {
	res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}

function readBody(req) {
	return new Promise((resolveBody, reject) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			try {
				const raw = Buffer.concat(chunks).toString('utf8');
				resolveBody(raw ? JSON.parse(raw) : {});
			} catch (e) {
				reject(e);
			}
		});
		req.on('error', reject);
	});
}

function requireOwner(req, res) {
	const session = getSession(req);
	if (!session) {
		sendJson(res, 401, { error: 'Yêu cầu đăng nhập Owner', requiresLogin: true });
		return null;
	}
	return session;
}

async function handleApi(req, res, url) {
	try {
		if (req.method === 'GET' && url.pathname === '/api/session') {
			const session = getSession(req);
			return sendJson(res, 200, {
				authenticated: Boolean(session),
				user: session?.user ?? null,
				localUrl: localUrl(),
			});
		}

		if (req.method === 'POST' && url.pathname === '/api/login') {
			const body = await readBody(req);
			const result = await authenticateOwner({
				email: body.email?.trim(),
				password: body.password,
			});
			const token = randomUUID();
			sessions.set(token, {
				user: result.user,
				cookie: result.cookie,
				expiresAt: Date.now() + SESSION_TTL_MS,
			});
			setSessionCookie(res, token);
			return sendJson(res, 200, {
				ok: true,
				user: result.user,
				state: getDashboardState(result.user),
			});
		}

		if (req.method === 'POST' && url.pathname === '/api/logout') {
			const session = getSession(req);
			if (session?.token) sessions.delete(session.token);
			clearSessionCookie(res);
			return sendJson(res, 200, { ok: true });
		}

		const session = requireOwner(req, res);
		if (!session) return;

		if (req.method === 'GET' && url.pathname === '/api/state') {
			return sendJson(res, 200, getDashboardState(session.user));
		}

		if (req.method === 'POST' && url.pathname === '/api/fetch') {
			const body = await readBody(req);
			const topicFilter = body.topic?.trim() ? resolveTopicFilter(body.topic) : null;
			const result = await runFetch(topicFilter, {
				rows: body.rows ? Number(body.rows) : undefined,
				minScore: body.minScore ? Number(body.minScore) : undefined,
			});
			return sendJson(res, 200, {
				ok: true,
				...result,
				state: getDashboardState(session.user),
			});
		}

		if (req.method === 'POST' && url.pathname.startsWith('/api/approve/')) {
			const id = url.pathname.split('/').pop();
			approveByIds([id]);
			return sendJson(res, 200, { ok: true, state: getDashboardState(session.user) });
		}

		if (req.method === 'POST' && url.pathname.startsWith('/api/reject/')) {
			const id = url.pathname.split('/').pop();
			rejectById(id);
			return sendJson(res, 200, { ok: true, state: getDashboardState(session.user) });
		}

		if (req.method === 'POST' && url.pathname.startsWith('/api/reset/')) {
			const id = url.pathname.split('/').pop();
			resetReview(id);
			return sendJson(res, 200, { ok: true, state: getDashboardState(session.user) });
		}

		if (req.method === 'POST' && url.pathname === '/api/import') {
			const log = await runImport();
			return sendJson(res, 200, { ok: true, log, state: getDashboardState(session.user) });
		}

		return sendJson(res, 404, { error: 'Not found' });
	} catch (error) {
		return sendJson(res, 500, { error: error.message ?? String(error) });
	}
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

	if (url.pathname.startsWith('/api/')) {
		return handleApi(req, res, url);
	}

	if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(readFileSync(UI_HTML, 'utf8'));
		return;
	}

	res.writeHead(404);
	res.end('Not found');
});

server.listen(PORT, () => {
	console.log(`Trending Workflows UI → http://localhost:${PORT}`);
	console.log('Yêu cầu đăng nhập tài khoản n8n Owner (global:owner)');
});
