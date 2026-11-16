#!/usr/bin/env node
/**
 * One command to play a game locally: starts the mock RGS and the app's dev server together, then
 * opens the game in your browser with the launch query string (sessionID, rgs_url, ...) the same
 * way Stake Engine launches it. Ctrl+C stops both.
 *
 *   pnpm dev                 -> cluster
 *   pnpm dev:price           -> price
 *   pnpm dev --no-open       -> don't open the browser, only print the URL
 */
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GAMES = {
	cluster: { devPort: 3001, rgsPort: 4000 },
	price: { devPort: 3002, rgsPort: 4001 },
};

const game = process.argv[2] ?? 'cluster';
const openBrowser = !process.argv.includes('--no-open');
const ports = GAMES[game];
if (!ports) {
	console.error(`Unknown game "${game}". Available: ${Object.keys(GAMES).join(', ')}`);
	process.exit(1);
}

// Same query string Stake Engine adds when it launches a game, pointing at the local mock RGS.
const url =
	`http://localhost:${ports.devPort}/?sessionID=local&rgs_url=http://localhost:${ports.rgsPort}` +
	`&lang=en&currency=USD&device=desktop`;

const open = (target) => {
	// No shell involved, so the `&` in the query string is passed through untouched.
	// (explorer.exe does not reliably open URLs with a query string; the URL protocol handler does.)
	const [command, args] =
		process.platform === 'win32'
			? ['rundll32.exe', ['url.dll,FileProtocolHandler', target]]
			: process.platform === 'darwin'
				? ['open', [target]]
				: ['xdg-open', [target]];
	try {
		spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
	} catch {}
};

const children = [];

// `command` is either [file, ...args] (spawned directly) or a string (run through the shell,
// needed for `pnpm` on Windows where it is a .cmd shim).
const run = (label, command, onLine) => {
	const child = Array.isArray(command)
		? spawn(command[0], command.slice(1), { cwd: ROOT })
		: spawn(command, { cwd: ROOT, shell: true });
	const forward = (stream, out) => {
		let buffer = '';
		stream.on('data', (chunk) => {
			buffer += chunk;
			const lines = buffer.split('\n');
			buffer = lines.pop();
			for (const line of lines) {
				out.write(`${label} ${line}\n`);
				onLine?.(line);
			}
		});
	};
	forward(child.stdout, process.stdout);
	forward(child.stderr, process.stderr);
	child.on('exit', (code) => {
		console.log(`${label} exited (${code ?? 'signal'})`);
		stopAll(code ?? 0);
	});
	children.push(child);
	return child;
};

let stopping = false;
function stopAll(code = 0) {
	if (stopping) return;
	stopping = true;
	for (const child of children) {
		if (child.exitCode !== null) continue;
		try {
			// shell: true on Windows means child.pid is the shell; kill the whole tree.
			if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
			else child.kill('SIGTERM');
		} catch {}
	}
	process.exit(code);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

run('\x1b[35m[rgs]\x1b[0m', [
	process.execPath,
	'tools/mock-rgs/server.mjs',
	'--game', game,
	'--port', String(ports.rgsPort),
	'--dev-port', String(ports.devPort),
]);

let announced = false;
run('\x1b[36m[app]\x1b[0m', `pnpm exec turbo run dev --filter=${game}`, (line) => {
	// eslint-disable-next-line no-control-regex
	if (!announced && /Local:/.test(line.replace(/\x1b\[[0-9;]*m/g, ''))) {
		announced = true;
		console.log(
			`\n  \x1b[1m${game} is running with the local mock RGS.\x1b[0m` +
				`\n  Open this URL (not the bare "Local:" one above, it has no session):` +
				`\n  \x1b[32m${url}\x1b[0m\n`,
		);
		if (openBrowser) open(url);
	}
});
