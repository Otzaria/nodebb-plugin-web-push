'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deferred, tick, pluginFixture } = require('./helpers');

test('push completion includes all deliveries; preparation is batched and sends are bounded', async () => {
	const devices = new Map(Array.from({ length: 250 }, (_, idx) => [idx + 1, new Set([
		{ endpoint: `https://push.invalid/${idx + 1}/a` },
		{ endpoint: `https://push.invalid/${idx + 1}/b` },
	])]));
	const gate = deferred();
	let active = 0;
	let peak = 0;
	let settled = false;
	const { plugin, notification, calls } = pluginFixture({
		devices,
		send: async () => {
			active += 1;
			peak = Math.max(peak, active);
			await gate.promise;
			active -= 1;
		},
	});
	const result = plugin.onNotificationPush({ notification, uidsNotified: Array.from(devices.keys()) });
	result.then(() => { settled = true; });
	await tick();
	assert.equal(settled, false);
	assert.equal(calls.sent.length, 8);
	assert.equal(calls.listed.length, 1);
	assert.equal(calls.listed[0].length, 100);
	gate.resolve();
	await result;
	assert.equal(calls.sent.length, 500);
	assert.equal(peak, 8);
	assert.deepEqual(calls.listed.map(uids => uids.length), [100, 100, 50]);
	assert.deepEqual(calls.settings.map(uids => uids.length), [100, 100, 50]);
	assert.equal(calls.expired.length, 3);
	for (const [, payload, options] of calls.sent) {
		assert.equal(options.timeout, 15000);
		assert.equal(JSON.parse(payload).tag, 'n1');
		assert.equal(JSON.parse(payload).data.url, 'https://forum.invalid/topic/1');
	}
});

test('awaits recipient expiry and propagates expiry failure before sending', async () => {
	const gate = deferred();
	const { plugin, notification, calls } = pluginFixture({ db: { pexpire: () => gate.promise } });
	const result = plugin.onNotificationPush({ notification, uidsNotified: [1] });
	const rejection = assert.rejects(result, /expiry failed/);
	await tick();
	assert.equal(calls.sent.length, 0);
	gate.reject(new Error('expiry failed'));
	await rejection;
	assert.equal(calls.sent.length, 0);
});

test('inactive users and empty broadcasts do not produce sends or empty set writes', async () => {
	const { plugin, notification, calls } = pluginFixture({ devices: new Map() });
	await plugin.onNotificationPush({ notification, uidsNotified: [1, 2] });
	await plugin.onNotificationPush({ notification, uidsNotified: [] });
	assert.equal(calls.sent.length, 0);
	assert.equal(calls.stored.length, 0);
	assert.equal(calls.settings.length, 0);
});

test('rescinds reach all users and devices with correct unmerged and merged tags', async () => {
	const requested = [];
	const devices = new Map([1, 2, 3].map(uid => [uid, new Set([
		{ endpoint: `https://push.invalid/${uid}/a` },
		{ endpoint: `https://push.invalid/${uid}/b` },
	])]));
	const { plugin, calls } = pluginFixture({
		devices,
		db: {
			getObjectsFields: async () => [null, { mergeId: 'topic:4' }, { mergeId: 'topic:4' }, null],
			getSetsMembers: async (keys) => {
				requested.push(...keys);
				return [keys[0] === 'web-push:nid:11:uids' ? [1, 2] : [2, 3]];
			},
		},
	});
	await plugin.onNotificationRescind({ nids: [11, 12, 13, 11] });
	assert.deepEqual(requested, ['web-push:nid:11:uids', 'web-push:nid:topic:4:uids']);
	assert.equal(calls.sent.length, 8);
	assert.equal(calls.sent.filter(([, payload]) => JSON.parse(payload).tag === 11).length, 4);
	assert.equal(calls.sent.filter(([, payload]) => JSON.parse(payload).tag === 'topic:4').length, 4);
	assert.ok(calls.sent.some(([sub]) => sub.endpoint === 'https://push.invalid/3/b'));
});

test('push, rescind and test routes share the same cap and expose completion', async () => {
	const devices = new Map(Array.from({ length: 20 }, (_, idx) => [idx + 1, new Set([{ endpoint: `https://push.invalid/${idx + 1}` }])]));
	const gate = deferred();
	let active = 0;
	let peak = 0;
	const { plugin, calls, notification } = pluginFixture({
		devices,
		send: async () => {
			active += 1;
			peak = Math.max(peak, active);
			await gate.promise;
			active -= 1;
		},
	});
	const router = {};
	await plugin.addRoutes({
		router,
		middleware: {},
		helpers: { formatApiResponse: code => calls.responses.push(code) },
	});
	const push = plugin.onNotificationPush({ notification, uidsNotified: Array.from(devices.keys()) });
	const rescind = plugin.onNotificationRescind({ nids: ['n1'] });
	const testSend = router['/web-push/test']({ uid: 1, body: { subscription: { endpoint: 'https://push.invalid/test' } } }, {});
	let settled = 0;
	const results = [push, rescind, testSend].map(promise => promise.then(() => { settled += 1; }));
	await tick();
	assert.equal(peak, 8);
	assert.equal(calls.sent.length, 8);
	assert.equal(settled, 0);
	assert.deepEqual(calls.responses, []);
	gate.resolve();
	await Promise.all(results);
	assert.equal(peak, 8);
	assert.equal(calls.sent.length, 41);
	assert.equal(settled, 3);
	assert.deepEqual(calls.responses, [200]);
});

test('only explicit 404/410 responses remove subscriptions and cleanup is awaited', async () => {
	const statuses = [404, 410, 429, 500, 503, 401, undefined];
	const devices = new Map(statuses.map((status, idx) => [idx + 1, new Set([{ endpoint: `https://push.invalid/${idx + 1}`, status }])]));
	const cleanup = deferred();
	const { plugin, calls, notification } = pluginFixture({
		devices,
		send: async sub => { throw Object.assign(new Error('failed'), { statusCode: sub.status, code: 'EFAIL' }); },
		remove: () => cleanup.promise,
	});
	let settled = false;
	const result = plugin.onNotificationPush({ notification, uidsNotified: Array.from(devices.keys()) });
	result.then(() => { settled = true; });
	await tick();
	assert.equal(settled, false);
	assert.deepEqual(calls.removed.map(([uid]) => uid), [1, 2]);
	cleanup.resolve();
	await result;
	assert.equal(calls.sent.length, statuses.length);
	assert.equal(calls.info.length, statuses.length);
	await plugin.onNotificationPush({ notification, uidsNotified: [3, 4, 5, 6, 7] });
	assert.equal(calls.sent.length, statuses.length + 5);
	assert.deepEqual(calls.removed.map(([uid]) => uid), [1, 2]);
});

test('cleanup failure is logged and does not abort unrelated deliveries', async () => {
	const { plugin, calls, notification } = pluginFixture({
		devices: new Map([1, 2].map(uid => [uid, new Set([{ endpoint: `https://push.invalid/${uid}` }])])),
		send: async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); },
		remove: async () => { throw new Error('database unavailable'); },
	});
	await plugin.onNotificationPush({ notification, uidsNotified: [1, 2] });
	assert.equal(calls.sent.length, 2);
	assert.equal(calls.errors.length, 2);
	assert.match(calls.errors[0], /cleanup failed/);
});

test('test route propagates errors without deleting an arbitrary supplied subscription', async () => {
	const { plugin, calls } = pluginFixture({ send: async () => { throw new Error('Socket timeout'); } });
	const router = {};
	await plugin.addRoutes({ router, middleware: {}, helpers: { formatApiResponse: code => calls.responses.push(code) } });
	await assert.rejects(router['/web-push/test']({ uid: 1, body: { subscription: {} } }, {}), /Socket timeout/);
	assert.deepEqual(calls.responses, []);
	assert.deepEqual(calls.removed, []);
});

test('overload rejects the whole new event before reading its recipients', async () => {
	const gate = deferred();
	const { plugin, calls, notification } = pluginFixture({ send: () => gate.promise });
	const accepted = Array.from({ length: 64 }, () => plugin.onNotificationPush({ notification, uidsNotified: [1] }));
	await assert.rejects(plugin.onNotificationPush({ notification, uidsNotified: [999] }), { code: 'WEB_PUSH_QUEUE_FULL' });
	gate.resolve();
	await Promise.all(accepted);
	assert.ok(calls.listed.every(uids => !uids.includes(999)));
	assert.equal(calls.sent.length, 64);
});
