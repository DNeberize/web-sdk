#!/usr/bin/env node
/**
 * Local mock of the Stake Engine RGS (Remote Gaming Server).
 *
 * Lets `pnpm run dev --filter=<app>` run end-to-end without a Stake Engine account:
 * authenticate, balance, play, end-round, event and replay are served from books on disk.
 *
 *   pnpm mock-rgs                         # sample books of apps/cluster (src/stories/data/*_books.ts)
 *   pnpm mock-rgs --game price            # sample books of another app
 *   pnpm mock-rgs --math <publish_files>  # math-sdk output (index.json + books_*.jsonl[.zst] + lookUpTable_*.csv)
 *
 * Then open the URL it prints (dev server must be running on port 3001).
 * No dependencies; needs Node >= 22.18 / 23.6 (loads the .ts sample books with built-in type stripping).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API_AMOUNT_MULTIPLIER = 1_000_000; // same as constants-shared/bet

const { values: args } = parseArgs({
	options: {
		game: { type: 'string', default: 'cluster' },
		math: { type: 'string' },
		port: { type: 'string', default: '4000' },
		balance: { type: 'string', default: '1000' },
		currency: { type: 'string', default: 'USD' },
		'dev-port': { type: 'string', default: '3001' },
		help: { type: 'boolean', short: 'h', default: false },
	},
});

if (args.help) {
	console.log(`Usage: pnpm mock-rgs [--game lines] [--math <publish_files dir>] [--port 4000]
                     [--balance 1000] [--currency USD] [--dev-port 3001]`);
	process.exit(0);
}

const PORT = Number(args.port);
const START_BALANCE = Math.round(Number(args.balance) * API_AMOUNT_MULTIPLIER);
const CURRENCY = args.currency;

// Bet levels in dollars -> API units. MOST_USED_BET_INDEXES in constants-shared needs >= 39 levels.
const BET_LEVELS = [
	0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9,
	10, 12, 14, 16, 18, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100,
].map((level) => Math.round(level * API_AMOUNT_MULTIPLIER));

const CONFIG = {
	gameID: args.math ? path.basename(path.resolve(args.math, '..', '..')) : `mock_${args.game}`,
	minBet: BET_LEVELS[0],
	maxBet: BET_LEVELS[BET_LEVELS.length - 1],
	stepBet: 10_000,
	defaultBetLevel: 1 * API_AMOUNT_MULTIPLIER,
	betLevels: BET_LEVELS,
	betModes: {},
	jurisdiction: {
		socialCasino: false,
		disabledFullscreen: false,
		disabledTurbo: false,
		disabledSuperTurbo: false,
		disabledAutoplay: false,
		disabledSlamstop: false,
		disabledSpacebar: false,
		disabledBuyFeature: false,
		displayNetPosition: false,
		displayRTP: false,
		displaySessionTimer: false,
		minimumRoundDuration: 0,
	},
};

// ---------------------------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ name: string, cost: number, payoutScale: number, ids: number[],
 *   getBook: (id: number) => any, cumulative: number[] | null }} Mode
 */
/** @type {Record<string, Mode>} */
const modes = {};

/** Sample books shipped with an app (what Storybook uses). payoutMultiplier is already a float. */
async function loadFromApp(game) {
	const appDir = path.join(ROOT, 'apps', game);
	const dataDir = path.join(appDir, 'src', 'stories', 'data');
	if (!fs.existsSync(dataDir)) {
		throw new Error(`No sample books in ${dataDir}. Pass --math <publish_files dir> instead.`);
	}

	let betModes = {};
	try {
		const config = await import(pathToFileURL(path.join(appDir, 'src', 'game', 'config.ts')).href);
		betModes = config.default?.betModes ?? {};
	} catch (error) {
		console.warn(`Could not read bet mode costs from ${game}/src/game/config.ts, using cost 1.`);
	}

	for (const file of fs.readdirSync(dataDir).filter((f) => f.endsWith('_books.ts'))) {
		const name = file.replace(/_books\.ts$/, '').toLowerCase();
		const books = (await import(pathToFileURL(path.join(dataDir, file)).href)).default;
		const byId = new Map(books.map((book) => [Number(book.id), book]));
		modes[name] = {
			name,
			cost: Number(betModes[name]?.cost ?? 1),
			payoutScale: 1,
			ids: [...byId.keys()],
			getBook: (id) => byId.get(id),
			cumulative: null, // uniform pick
		};
	}
}

/** Output of the Stake math-sdk (library/publish_files). payoutMultiplier is an int x100. */
async function loadFromMath(dir) {
	const indexFile = path.join(dir, 'index.json');
	if (!fs.existsSync(indexFile)) throw new Error(`No index.json in ${dir}`);
	const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));

	for (const entry of index.modes) {
		const name = String(entry.name).toLowerCase();
		const rawById = new Map();
		const booksFile = path.join(dir, entry.events);
		let input = fs.createReadStream(booksFile);
		if (booksFile.endsWith('.zst')) input = input.pipe(zlib.createZstdDecompress());

		// Keep lines as raw strings and parse on demand: books files can be hundreds of MB.
		for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
			const match = /"id"\s*:\s*(\d+)/.exec(line);
			if (match) rawById.set(Number(match[1]), line);
		}

		let ids = [...rawById.keys()];
		let cumulative = null;
		if (entry.weights && fs.existsSync(path.join(dir, entry.weights))) {
			ids = [];
			cumulative = [];
			let total = 0;
			for (const row of fs.readFileSync(path.join(dir, entry.weights), 'utf8').split(/\r?\n/)) {
				const [id, weight] = row.split(',').map(Number);
				if (!Number.isFinite(id) || !(weight > 0) || !rawById.has(id)) continue;
				total += weight;
				ids.push(id);
				cumulative.push(total);
			}
		}

		modes[name] = {
			name,
			cost: Number(entry.cost ?? 1),
			payoutScale: 100,
			ids,
			getBook: (id) => (rawById.has(id) ? JSON.parse(rawById.get(id)) : undefined),
			cumulative,
		};
	}
}

/** Book ids queued with /mock/force, consumed by the next play in that mode. */
const forced = {};

function pickBook(mode) {
	const queue = forced[mode.name];
	if (queue?.length) {
		const id = queue.shift();
		const book = mode.getBook(id);
		if (book) return book;
		console.warn(`Forced book ${id} not found in mode "${mode.name}", picking randomly.`);
	}

	if (mode.cumulative) {
		const target = Math.random() * mode.cumulative[mode.cumulative.length - 1];
		let low = 0;
		let high = mode.cumulative.length - 1;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (mode.cumulative[mid] > target) high = mid;
			else low = mid + 1;
		}
		return mode.getBook(mode.ids[low]);
	}

	return mode.getBook(mode.ids[Math.floor(Math.random() * mode.ids.length)]);
}

// ---------------------------------------------------------------------------------------------
// Sessions (in memory, any sessionID is accepted)
// ---------------------------------------------------------------------------------------------

let nextRoundID = 1;
const sessions = new Map();

function getSession(sessionID) {
	const key = sessionID || 'local';
	if (!sessions.has(key)) sessions.set(key, { balance: START_BALANCE, round: null });
	return sessions.get(key);
}

const balanceObject = (session) => ({ amount: session.balance, currency: CURRENCY });

class RgsError extends Error {
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

const findMode = (modeName) => {
	const mode = modes[String(modeName ?? '').toLowerCase()];
	if (!mode) {
		throw new RgsError(
			'ERR_VAL',
			`Unknown mode "${modeName}". Available: ${Object.keys(modes).join(', ')}`,
		);
	}
	return mode;
};

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

const routes = {
	'POST /wallet/authenticate': ({ body }) => {
		const session = getSession(body.sessionID);
		return {
			balance: balanceObject(session),
			config: CONFIG,
			...(session.round ? { round: session.round } : {}),
		};
	},

	'POST /wallet/balance': ({ body }) => ({ balance: balanceObject(getSession(body.sessionID)) }),

	'POST /wallet/play': ({ body }) => {
		const session = getSession(body.sessionID);
		const mode = findMode(body.mode);
		const amount = Number(body.amount);

		if (session.round?.active) {
			throw new RgsError('ERR_VAL', 'Previous round is still active. Call /wallet/end-round first.');
		}
		if (!BET_LEVELS.includes(amount)) {
			throw new RgsError('ERR_VAL', `Bet amount ${amount} is not one of config.betLevels.`);
		}

		const cost = Math.round(amount * mode.cost);
		if (cost > session.balance) throw new RgsError('ERR_IPB', 'Insufficient balance.');

		const book = pickBook(mode);
		const payoutMultiplier = Number(book.payoutMultiplier ?? 0) / mode.payoutScale;
		const payout = Math.round(amount * payoutMultiplier);

		session.balance -= cost;
		session.round = {
			betID: nextRoundID,
			roundID: nextRoundID++,
			bookID: book.id,
			amount,
			payout,
			payoutMultiplier,
			costMultiplier: mode.cost,
			active: payout > 0,
			mode: body.mode,
			event: null,
			state: book.events,
		};

		console.log(
			`play   mode=${mode.name} book=${book.id} bet=${amount / API_AMOUNT_MULTIPLIER} ` +
				`cost=${cost / API_AMOUNT_MULTIPLIER} x${payoutMultiplier} -> ${payout / API_AMOUNT_MULTIPLIER}`,
		);

		return { balance: balanceObject(session), round: session.round };
	},

	'POST /wallet/end-round': ({ body }) => {
		const session = getSession(body.sessionID);
		if (session.round?.active) {
			session.balance += session.round.payout;
			session.round.active = false;
			console.log(`end    round=${session.round.roundID} +${session.round.payout / API_AMOUNT_MULTIPLIER}`);
		}
		return { balance: balanceObject(session) };
	},

	'POST /bet/event': ({ body }) => {
		const session = getSession(body.sessionID);
		if (session.round?.active) session.round.event = String(body.event);
		return { event: body.event };
	},

	// Replay: /bet/replay/:game/:version/:mode/:event, where event is the book id.
	'GET /bet/replay': ({ params }) => {
		const [, , modeName, bookID] = params;
		const mode = findMode(modeName);
		const book = mode.getBook(Number(bookID));
		if (!book) throw new RgsError('ERR_VAL', `Book ${bookID} not found in mode "${mode.name}".`, 404);
		return {
			payoutMultiplier: Number(book.payoutMultiplier ?? 0) / mode.payoutScale,
			costMultiplier: mode.cost,
			state: book.events,
		};
	},

	// Dev helpers -----------------------------------------------------------------------------

	// Queue a specific book for the next spin: /mock/force?mode=bonus&id=12 (repeat id for more spins)
	'GET /mock/force': ({ query }) => {
		const mode = findMode(query.get('mode') ?? 'base');
		const ids = query.getAll('id').map(Number);
		if (!ids.length || ids.some((id) => !mode.getBook(id))) {
			throw new RgsError('ERR_VAL', `Pass existing book ids with ?id=. Mode "${mode.name}" has ${mode.ids.length} books.`);
		}
		forced[mode.name] = [...(forced[mode.name] ?? []), ...ids];
		return { mode: mode.name, queued: forced[mode.name] };
	},

	// Reset balance / active round: /mock/reset?sessionID=local
	'GET /mock/reset': ({ query }) => {
		sessions.delete(query.get('sessionID') || 'local');
		return { ok: true };
	},

	'GET /mock/status': () => ({
		modes: Object.values(modes).map((mode) => ({
			name: mode.name,
			cost: mode.cost,
			books: mode.ids.length,
			weighted: Boolean(mode.cumulative),
			forced: forced[mode.name] ?? [],
		})),
		sessions: Object.fromEntries(
			[...sessions].map(([id, session]) => [
				id,
				{
					balance: session.balance / API_AMOUNT_MULTIPLIER,
					activeRound: session.round?.active ? session.round.roundID : null,
				},
			]),
		),
	}),
};

function matchRoute(method, pathname) {
	const exact = routes[`${method} ${pathname}`];
	if (exact) return { handler: exact, params: [] };
	if (method === 'GET' && pathname.startsWith('/bet/replay/')) {
		const params = pathname.slice('/bet/replay/'.length).split('/').map(decodeURIComponent);
		return { handler: routes['GET /bet/replay'], params };
	}
	return null;
}

const server = http.createServer(async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Access-Control-Allow-Private-Network', 'true');

	if (req.method === 'OPTIONS') {
		res.writeHead(204).end();
		return;
	}

	const url = new URL(req.url, `http://${req.headers.host}`);
	const send = (status, data) => {
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(data));
	};

	const route = matchRoute(req.method, url.pathname);
	if (!route) {
		send(404, { error: 'ERR_NF', message: `${req.method} ${url.pathname} is not mocked.` });
		return;
	}

	try {
		let raw = '';
		for await (const chunk of req) raw += chunk;
		const body = raw ? JSON.parse(raw) : {};
		send(200, await route.handler({ body, query: url.searchParams, params: route.params }));
	} catch (error) {
		const status = error instanceof RgsError ? error.status : 500;
		const code = error instanceof RgsError ? error.code : 'ERR_GEN';
		console.warn(`${req.method} ${url.pathname} -> ${code}: ${error.message}`);
		send(status, { error: code, message: error.message });
	}
});

// ---------------------------------------------------------------------------------------------

if (args.math) await loadFromMath(path.resolve(args.math));
else await loadFromApp(args.game);

if (!Object.keys(modes).length) {
	console.error('No bet modes loaded.');
	process.exit(1);
}

server.listen(PORT, () => {
	const rgsUrl = `http://localhost:${PORT}`;
	const devUrl = `http://localhost:${args['dev-port']}/?sessionID=local&rgs_url=${rgsUrl}&lang=en&currency=${CURRENCY}&device=desktop`;
	console.log(`\nMock RGS on ${rgsUrl}  (${args.math ? `math: ${args.math}` : `game: ${args.game}`})`);
	for (const mode of Object.values(modes)) {
		console.log(`  mode ${mode.name.padEnd(10)} cost x${mode.cost}  ${mode.ids.length} books${mode.cumulative ? ' (weighted)' : ''}`);
	}
	console.log(`\nOpen the game (dev server must be running):\n  ${devUrl}`);
	console.log(`\nHelpers:\n  ${rgsUrl}/mock/status\n  ${rgsUrl}/mock/force?mode=bonus&id=1\n  ${rgsUrl}/mock/reset\n`);
});
