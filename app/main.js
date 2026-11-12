import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { openapi } from './openapi.js';

// The tour ratings of the Hackertours consoles: after a tour a guest rates its content, its guide and its length, optionally with a
// drawing. The ratings are for the team: there is no public read API. A rating carries no personal data, and no address is logged.

export const idPattern = /^[A-Za-z0-9._-]{1,64}$/;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const length = value => [...value].length;
const string = max => value => typeof value === 'string' && length(value) <= max;
const nullable = check => value => value === null || check(value);
const integer = (min, max = Number.MAX_SAFE_INTEGER) => value => Number.isSafeInteger(value) && value >= min && value <= max;
const oneOf = (...values) => value => values.includes(value);
// The fields of a rating, in their column order; the request body has exactly these.
const fields = {
    id: value => typeof value === 'string' && idPattern.test(value),
    time: integer(0),
    session: nullable(string(64)),
    organizer: string(64),
    event: string(64),
    item_id: integer(0),
    tour: string(200),
    lang: oneOf('en', 'de'),
    content: nullable(integer(1, 5)),
    guide: nullable(integer(1, 5)),
    duration: nullable(oneOf('way_too_short', 'too_short', 'perfect', 'too_long', 'way_too_long')),
    game_title_id: nullable(string(32)),
    game_name: nullable(string(200)),
    game_type: nullable(oneOf('disc', 'arcade', 'gba')),
    build: string(64),
};
const names = Object.keys(fields);

export function createApp({
    databasePath = process.env.DATABASE_PATH || '/data/ratings.sqlite',
    drawingsPath = process.env.DRAWINGS_PATH || '/data/drawings',
    issuer = process.env.OAUTH_URL || 'https://sso.by.vincent.mahn.ke/realms/sso.by.vincent.mahn.ke',
    clients = {
        '3ds': process.env.OAUTH_CONSOLE_3DS_CLIENT_ID,
        xbox: process.env.OAUTH_CONSOLE_XBOX_CLIENT_ID,
        switch: process.env.OAUTH_CONSOLE_SWITCH_CLIENT_ID,
        gba: process.env.OAUTH_CONSOLE_GBA_CLIENT_ID,
    },
    jwks,
    now = () => Date.now(),
    rateLimit = 120,
} = {}) {
    const platforms = new Map();
    for (const [platform, clientId] of Object.entries(clients)) {
        if (!clientId) continue;
        if (platforms.has(clientId)) throw new Error(`The client id of ${platform} is the same as another platform's`);
        platforms.set(clientId, platform);
    }
    if (!platforms.size) throw new Error('At least one OAUTH_CONSOLE_*_CLIENT_ID is required');
    const keys = jwks || createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`));
    mkdirSync(drawingsPath, { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec(`PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS ratings (
            platform TEXT NOT NULL, id TEXT NOT NULL, time INTEGER NOT NULL, session TEXT,
            organizer TEXT NOT NULL, event TEXT NOT NULL, item_id INTEGER NOT NULL, tour TEXT NOT NULL, lang TEXT NOT NULL,
            content INTEGER, guide INTEGER, duration TEXT,
            game_title_id TEXT, game_name TEXT, game_type TEXT, build TEXT NOT NULL,
            PRIMARY KEY (platform, id)
        );`);
    const columns = ['platform', ...names];
    const insert = db.prepare(`INSERT INTO ratings (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    const byId = db.prepare(`SELECT ${columns.join(', ')} FROM ratings WHERE platform = ? AND id = ?`);
    const buckets = new Map();

    const send = (res, status, value, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
        res.end(JSON.stringify(value));
    };
    // Reads the body up to `limit` bytes; null when it is longer.
    const read = async (req, limit) => {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > limit) return null;
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    };
    // The platform of a request's valid token, after its client's quota; otherwise answers the request and returns null.
    const authorize = async (req, res) => {
        const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization || '');
        if (!bearer) return send(res, 401, { error: 'Bearer token required' }, { 'WWW-Authenticate': 'Bearer' }), null;
        let payload;
        try {
            ({ payload } = await jwtVerify(bearer[1], keys, {
                issuer, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'azp'], currentDate: new Date(now()),
            }));
        } catch {
            return send(res, 401, { error: 'Invalid or expired token' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' }), null;
        }
        const platform = platforms.get(payload.azp);
        if (!platform) return send(res, 403, { error: 'Client is not allowed' }), null;
        const minute = Math.floor(now() / 60000);
        const bucket = buckets.get(payload.azp);
        const count = bucket?.minute === minute ? bucket.count + 1 : 1;
        buckets.set(payload.azp, { minute, count });
        if (count > rateLimit) {
            return send(res, 429, { error: 'Rate limit exceeded' }, { 'Retry-After': String(60 - Math.floor(now() / 1000) % 60) }), null;
        }
        return platform;
    };

    const submit = async (req, res) => {
        const platform = await authorize(req, res);
        if (!platform) return;
        if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) return send(res, 400, { error: 'Content-Type must be application/json' });
        const raw = await read(req, 4096);
        if (!raw) return send(res, 400, { error: 'Body exceeds 4096 bytes' });
        let body;
        try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
        if (!body || Array.isArray(body) || typeof body !== 'object') return send(res, 400, { error: 'Body must be a JSON object' });
        const unknown = Object.keys(body).filter(name => !Object.hasOwn(fields, name));
        if (unknown.length) return send(res, 400, { error: `Unknown fields: ${unknown.join(', ')}` });
        const invalid = names.filter(name => !Object.hasOwn(body, name) || !fields[name](body[name]));
        if (invalid.length) return send(res, 400, { error: `Missing or invalid fields: ${invalid.join(', ')}` });
        const existing = byId.get(platform, body.id);
        if (existing) return send(res, 200, existing);
        insert.run(platform, ...names.map(name => body[name]));
        return send(res, 201, byId.get(platform, body.id));
    };

    const draw = async (req, res, encodedId) => {
        const platform = await authorize(req, res);
        if (!platform) return;
        let id;
        try { id = decodeURIComponent(encodedId); } catch { return send(res, 400, { error: 'Invalid rating id' }); }
        if (!idPattern.test(id)) return send(res, 400, { error: 'Invalid rating id' });
        if (!/^image\/png(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) return send(res, 400, { error: 'Content-Type must be image/png' });
        const png = await read(req, 65536);
        if (!png) return send(res, 400, { error: 'Body exceeds 65536 bytes' });
        if (png.length <= pngSignature.length || !png.subarray(0, pngSignature.length).equals(pngSignature)) return send(res, 400, { error: 'Body is not a PNG' });
        if (!byId.get(platform, id)) return send(res, 404, { error: 'Unknown rating' });
        const file = join(drawingsPath, `${platform}-${id}.png`);
        let previous = null;
        try { previous = readFileSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const result = { platform, id, bytes: png.length };
        if (previous?.equals(png)) return send(res, 200, result);
        // Written to a temporary file of the same directory and renamed over the drawing, so that a reader never sees half of it.
        const temporary = join(drawingsPath, `.${platform}-${id}.${randomBytes(6).toString('hex')}.tmp`);
        try {
            writeFileSync(temporary, png, { flush: true });
            renameSync(temporary, file);
        } catch (error) {
            rmSync(temporary, { force: true });
            throw error;
        }
        // A new drawing for a rating that has one replaces it (the console sends the guest's latest).
        return send(res, previous ? 200 : 201, result);
    };

    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            if (req.method === 'GET' && url.pathname === '/healthz') {
                db.prepare('SELECT 1').get();
                return send(res, 200, { status: 'ok' });
            }
            if (req.method === 'GET' && url.pathname === '/openapi.json') return send(res, 200, openapi);
            if (req.method === 'POST' && url.pathname === '/api/ratings') return await submit(req, res);
            const drawing = /^\/api\/ratings\/([^/]+)\/drawing$/.exec(url.pathname);
            if (req.method === 'PUT' && drawing) return await draw(req, res, drawing[1]);
            return send(res, 404, { error: 'Not found' });
        } catch (error) {
            console.error(error.message);
            if (!res.headersSent) send(res, 500, { error: 'Internal server error' });
            else res.destroy();
        }
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.once('close', () => db.close());
    return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const server = createApp();
    server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Ratings service listening'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
