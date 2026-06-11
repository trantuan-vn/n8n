#!/usr/bin/env node
/**
 * CLI for trending workflows — see scripts/trending-workflows.md
 * UI: pnpm trending:ui
 */
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	APPROVED_FILE,
	CANDIDATES_FILE,
	REPORT_FILE,
	getCandidatesData,
	getApprovedData,
	getDashboardState,
	parseTopicArg,
	resolveTopicFilter,
	runFetch,
	runImport,
	runSetup,
	approveByIds,
	rejectById,
	localUrl,
	localEmail,
	localPassword,
} from './trending-workflows-lib.mjs';

const UI_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'trending-workflows-ui.mjs');

async function cmdFetch(topicFilter) {
	const topicLabel = topicFilter
		? topicFilter.mode === 'category'
			? `category "${topicFilter.category}" (topic: ${topicFilter.topic})`
			: `search "${topicFilter.search}"`
		: 'all topics';
	console.log(`Fetching trending templates (${topicLabel})...`);
	const { count, skipped } = await runFetch(topicFilter);
	if (skipped.length) {
		for (const s of skipped) console.warn(`  skip #${s.id}: ${s.error}`);
	}
	console.log(`Saved ${count} candidates`);
	console.log(`  ${CANDIDATES_FILE}`);
	console.log(`  ${REPORT_FILE}`);
}

function cmdList() {
	const data = getCandidatesData();
	if (!data?.candidates?.length) {
		console.error('No candidates. Run: pnpm trending:fetch');
		process.exit(1);
	}
	const topicLine = data.topic ? ` · topic: ${data.topic}` : '';
	console.log(`\nTrending workflows — score >= ${data.minScore}${topicLine}\n`);
	for (const [i, w] of data.candidates.entries()) {
		console.log(`${String(i + 1).padStart(2)}. [${w.monetizationScore}] #${w.id} ${w.name}`);
		console.log(`    views: ${w.totalViews} | ${w.categories.join(', ') || '-'}`);
		console.log(`    ${w.templateUrl}`);
		console.log(`    ${w.reasons.join('; ')}\n`);
	}
}

async function cmdReview() {
	const data = getCandidatesData();
	if (!data?.candidates?.length) {
		console.error('No candidates. Run: pnpm trending:fetch');
		process.exit(1);
	}
	const approved = getApprovedData();
	const approvedIds = new Set(approved.approved.map((w) => w.id));
	const rejectedIds = new Set(approved.rejected.map((w) => w.id));
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	console.log('Review: y=approve, n=reject, s=skip, q=quit\n');

	for (const w of data.candidates) {
		if (approvedIds.has(w.id) || rejectedIds.has(w.id)) continue;
		console.log(`\n[${w.monetizationScore}] #${w.id} — ${w.name}`);
		console.log(`views: ${w.totalViews} | ${w.categories.join(', ')}`);
		console.log(w.description.slice(0, 200) + (w.description.length > 200 ? '…' : ''));
		const answer = (await rl.question('Approve? [y/n/s/q]: ')).trim().toLowerCase();
		if (answer === 'q') break;
		if (answer === 'y') approveByIds([w.id]);
		else if (answer === 'n') rejectById(w.id);
	}
	rl.close();
	const state = getDashboardState();
	console.log(`\nApproved: ${state.stats.approved} | Rejected: ${state.stats.rejected}`);
	console.log(`  ${APPROVED_FILE}`);
}

function cmdApprove(ids) {
	if (!ids.length) {
		console.error('Usage: node scripts/trending-workflows.mjs approve <id> [id...]');
		process.exit(2);
	}
	const { added } = approveByIds(ids);
	for (const id of added) console.log(`  approved #${id}`);
}

async function cmdImport() {
	const log = await runImport();
	for (const r of log.results) {
		if (r.status === 'ok') console.log(`  ✓ #${r.templateId} → ${r.localId}  ${r.name}`);
		else if (r.status === 'skipped') console.log(`  ↷ #${r.templateId} already imported`);
		else console.error(`  ✗ #${r.templateId}: ${r.error}`);
	}
	console.log(`\nLog saved`);
}

async function cmdSetup() {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const email = localEmail() || (await rl.question(`Email (${localUrl()}): `)).trim();
	const password = localPassword() || (await rl.question('Password: ')).trim();
	rl.close();
	await runSetup({ email, password });
	console.log('Owner login OK — API key saved. Next: pnpm trending:import');
}

function cmdOpen() {
	const approved = getApprovedData();
	if (!approved.approved.length) {
		console.error('Nothing approved yet.');
		process.exit(1);
	}
	for (const w of approved.approved) {
		console.log(`  #${w.id} ${w.name}`);
		console.log(`  ${localUrl()}/workflows/templates/${w.id}\n`);
	}
}

function cmdUi() {
	const port = process.env.TRENDING_UI_PORT ?? '3847';
	const child = spawn(process.execPath, [UI_SCRIPT], { stdio: 'inherit', env: { ...process.env, TRENDING_UI_PORT: port } });
	child.on('exit', (code) => process.exit(code ?? 0));
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
	case 'fetch': {
		const topic = parseTopicArg(args);
		const topicFilter = topic ? resolveTopicFilter(topic) : null;
		if (topic && topicFilter?.mode === 'category' && topicFilter.category !== topic) {
			console.log(`Topic "${topic}" → category "${topicFilter.category}"`);
		}
		await cmdFetch(topicFilter);
		break;
	}
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
	case 'ui':
		cmdUi();
		break;
	default:
		console.log(`Usage:
  pnpm trending:ui
  pnpm trending:fetch [--topic <chủ đề>]
  pnpm trending:list | review | approve <id> | import | setup`);
		process.exit(command ? 1 : 0);
}
