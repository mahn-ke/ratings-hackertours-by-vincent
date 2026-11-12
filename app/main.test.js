import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createApp } from './main.js';

const issuer = 'https://keycloak.example/realms/test';
const nowSeconds = 1792956000;
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'local', alg: 'RS256', use: 'sig' };
const jwks = createLocalJWKSet({ keys: [jwk] });
const clients = { '3ds': 'console-3ds', xbox: 'console-xbox', switch: 'console-switch', gba: 'console-gba' };
const token = async (azp = 'console-3ds') => new SignJWT({ azp })
    .setProtectedHeader({ alg: 'RS256', kid: 'local' }).setIssuer(issuer)
    .setSubject('service-account-console').setIssuedAt(nowSeconds).setExpirationTime(nowSeconds + 3600)
    .sign(privateKey);
const valid = {
    id: 'r-1792956000.abc_DEF', time: nowSeconds, session: 'a1b2c3d4', organizer: 'hackertours', event: '40c3', item_id: 17,
    tour: 'Hackertour (Deutsch)', lang: 'de', content: 5, guide: 4, duration: 'perfect',
    game_title_id: '4D5307E6', game_name: 'Halo 3', game_type: 'disc', build: '1.4.0-3-gabcdef',
};
const png = (...extra) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...extra]);

async function fixture(t, options = {}) {
    const directory = mkdtempSync(`.test-data-${process.pid}-`);
    const drawingsPath = `${directory}/drawings`;
    const server = createApp({ databasePath: ':memory:', drawingsPath, issuer, clients, jwks, now: () => nowSeconds * 1000, ...options });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        rmSync(directory, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const defaultToken = await token();
    const post = async (body = valid, accessToken = defaultToken, headers = {}) => fetch(`${base}/api/ratings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const put = async (id = valid.id, body = png(1), accessToken = defaultToken, headers = {}) => fetch(`${base}/api/ratings/${id}/drawing`, {
        method: 'PUT', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${accessToken}`, ...headers }, body,
    });
    return { server, base, post, put, drawingsPath: options.drawingsPath || drawingsPath, directory };
}

test('health, OpenAPI, no public read API', async t => {
    const { base, post } = await fixture(t);
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: 'ok' });
    const openapi = await (await fetch(`${base}/openapi.json`)).json();
    assert.equal(openapi.openapi, '3.0.3');
    assert.deepEqual(Object.keys(openapi.paths).sort(), ['/api/ratings', '/api/ratings/{id}/drawing', '/healthz']);
    assert.equal((await post()).status, 201);
    for (const path of ['/api/ratings', `/api/ratings/${valid.id}`, `/api/ratings/${valid.id}/drawing`]) {
        assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    }
});

test('stores a rating with the platform of its token and is idempotent per platform', async t => {
    const { post } = await fixture(t);
    const created = await post();
    assert.equal(created.status, 201);
    const row = await created.json();
    assert.deepEqual(row, { platform: '3ds', ...valid });
    const retry = await post({ ...valid, content: 1, tour: 'changed' });
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), row);
    for (const [platform, clientId] of Object.entries(clients).filter(([platform]) => platform !== '3ds')) {
        const other = await post(valid, await token(clientId));
        assert.equal(other.status, 201, platform);
        assert.equal((await other.json()).platform, platform);
    }
    const skipped = { ...valid, id: 'skipped', session: null, content: null, guide: null, duration: null, game_title_id: null, game_name: null, game_type: null };
    const stored = await post(skipped);
    assert.equal(stored.status, 201);
    assert.deepEqual(await stored.json(), { platform: '3ds', ...skipped });
    const longest = { ...valid, id: 'x'.repeat(64), session: 's'.repeat(64), organizer: 'o'.repeat(64), event: 'e'.repeat(64), tour: 'ü'.repeat(200),
        game_title_id: 't'.repeat(32), game_name: 'g'.repeat(200), build: 'b'.repeat(64), item_id: 0, time: 0, content: 1, guide: 5, game_type: 'arcade', lang: 'en' };
    assert.equal((await post(longest)).status, 201);
});

test('rejects malformed ratings without storing them', async t => {
    const { post } = await fixture(t);
    const without = name => Object.fromEntries(Object.entries(valid).filter(([key]) => key !== name));
    const cases = [null, [], 1, 'x', {}, { ...valid, extra: true }, { ...valid, platform: '3ds' }, without('session'), without('build'),
        ...['', 'a'.repeat(65), 'a/b', 'a b', 'ä', 12, null].map(id => ({ ...valid, id })),
        ...[-1, 1.5, '1792956000', null].map(time => ({ ...valid, time })),
        ...['s'.repeat(65), 1].map(session => ({ ...valid, session })),
        ...['o'.repeat(65), null, 1].map(organizer => ({ ...valid, organizer })),
        ...['e'.repeat(65), null].map(event => ({ ...valid, event })),
        ...[-1, 1.5, '17', null].map(item_id => ({ ...valid, item_id })),
        ...['t'.repeat(201), null].map(tour => ({ ...valid, tour })),
        ...['fr', 'EN', '', null].map(lang => ({ ...valid, lang })),
        ...[0, 6, 2.5, '5'].map(content => ({ ...valid, content })),
        ...[0, 6, true].map(guide => ({ ...valid, guide })),
        ...['ok', 'PERFECT', 3].map(duration => ({ ...valid, duration })),
        ...['t'.repeat(33), 7].map(game_title_id => ({ ...valid, game_title_id })),
        { ...valid, game_name: 'g'.repeat(201) }, { ...valid, game_type: 'cartridge' },
        ...['b'.repeat(65), null].map(build => ({ ...valid, build }))];
    for (const body of cases) assert.equal((await post(body)).status, 400, JSON.stringify(body));
    assert.equal((await post(valid, await token(), { 'Content-Type': 'text/plain' })).status, 400);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post(JSON.stringify({ ...valid, tour: 'x'.repeat(4096) }))).status, 400);
    assert.equal((await post()).status, 201);
});

test('requires a valid signed, unexpired, issuer-matched token of an allowed client', async t => {
    const { post, put } = await fixture(t);
    for (const response of [await post(valid, ''), await post(valid, 'garbage'), await put(valid.id, png(1), '')]) {
        assert.equal(response.status, 401);
        assert.match(response.headers.get('WWW-Authenticate'), /^Bearer/);
    }
    assert.equal((await post(valid, await token('unknown'))).status, 403);
    assert.equal((await put(valid.id, png(1), await token('unknown'))).status, 403);
    const sign = (payload, key = privateKey) => new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'local' }).sign(key);
    const payload = { iss: issuer, sub: 'service-account', iat: nowSeconds, exp: nowSeconds + 60, azp: 'console-3ds' };
    for (const changes of [{ iss: 'https://wrong.example' }, { exp: nowSeconds - 1 }, { exp: undefined }, { azp: undefined }, { sub: undefined }, { iat: undefined }, { nbf: nowSeconds + 300 }]) {
        assert.equal((await post(valid, await sign({ ...payload, ...changes }))).status, 401, JSON.stringify(changes));
    }
    const wrongKey = await generateKeyPair('RS256');
    assert.equal((await post(valid, await sign(payload, wrongKey.privateKey))).status, 401);
    assert.equal((await post()).status, 201);
});

test('rate limit is per client, covers drawings and resets next minute', async t => {
    let clock = nowSeconds * 1000;
    const { post, put } = await fixture(t, { rateLimit: 2, now: () => clock });
    assert.equal((await post()).status, 201);
    assert.equal((await put()).status, 201);
    const limited = await post();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('Retry-After')) > 0);
    assert.equal((await put()).status, 429);
    assert.equal((await post(valid, await token('console-xbox'))).status, 201);
    clock += 60000;
    assert.equal((await post()).status, 200);
});

test('stores, keeps and replaces a rating\'s drawing atomically under platform-id.png', async t => {
    const { put, post, drawingsPath } = await fixture(t);
    assert.equal((await put()).status, 404);
    assert.equal((await post()).status, 201);
    const created = await put();
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { platform: '3ds', id: valid.id, bytes: png(1).length });
    const file = `${drawingsPath}/3ds-${valid.id}.png`;
    assert.deepEqual(readFileSync(file), png(1));
    assert.equal((await put()).status, 200);
    const replaced = await put(valid.id, png(2, 3));
    assert.equal(replaced.status, 200);
    assert.deepEqual(readFileSync(file), png(2, 3));
    assert.deepEqual(readdirSync(drawingsPath), [`3ds-${valid.id}.png`]);
    // Another platform's rating of the same id is another rating.
    assert.equal((await put(valid.id, png(1), await token('console-switch'))).status, 404);
    assert.equal((await post(valid, await token('console-switch'))).status, 201);
    assert.equal((await put(valid.id, png(4), await token('console-switch'))).status, 201);
    assert.deepEqual(readFileSync(`${drawingsPath}/switch-${valid.id}.png`), png(4));
    assert.deepEqual(readFileSync(file), png(2, 3));
});

test('rejects invalid drawings', async t => {
    const { put, post, drawingsPath } = await fixture(t);
    assert.equal((await post()).status, 201);
    assert.equal((await put(valid.id, png(1), await token(), { 'Content-Type': 'application/octet-stream' })).status, 400);
    assert.equal((await put(valid.id, Buffer.from('GIF89a not a png'))).status, 400);
    assert.equal((await put(valid.id, png().subarray(0, 8))).status, 400);
    assert.equal((await put(valid.id, Buffer.concat([png(), Buffer.alloc(65536 - 12 + 1)]))).status, 400);
    for (const id of ['%ZZ', 'a%2Fb', '..%2Fx', 'a b', 'x'.repeat(65)]) assert.equal((await put(id)).status, 400, id);
    assert.deepEqual(readdirSync(drawingsPath), []);
    const largest = Buffer.concat([png(), Buffer.alloc(65536 - 12)]);
    assert.equal((await put(valid.id, largest)).status, 201);
});

test('SQLite and drawings survive closing and reopening the service', async t => {
    const directory = mkdtempSync(`.test-data-${process.pid}-`);
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const options = { databasePath: `${directory}/ratings.sqlite`, drawingsPath: `${directory}/drawings` };
    const first = await fixture(t, options);
    assert.equal((await first.post()).status, 201);
    assert.equal((await first.put()).status, 201);
    await new Promise(resolve => { first.server.closeAllConnections(); first.server.close(resolve); });
    const second = await fixture(t, options);
    assert.equal((await second.post()).status, 200);
    assert.equal((await second.put()).status, 200);
});

test('fails closed without a console client or with a shared client id', () => {
    for (const ids of [{}, { '3ds': '', xbox: undefined }]) {
        assert.throws(() => createApp({ databasePath: ':memory:', drawingsPath: '.test-data-unused', clients: ids }), /At least one/);
    }
    assert.throws(() => createApp({ databasePath: ':memory:', drawingsPath: '.test-data-unused', clients: { '3ds': 'a', gba: 'a' } }), /same as another/);
});

test('a platform without a client id is refused', async t => {
    const { post } = await fixture(t, { clients: { switch: 'console-switch' } });
    assert.equal((await post(valid, await token('console-3ds'))).status, 403);
    assert.equal((await post(valid, await token('console-switch'))).status, 201);
});
