'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deferred, tick, loadModule } = require('./helpers');

test('add publishes the user registry only after the subscription is stored', async () => {
	const stored = deferred();
	const calls = [];
	const subscriptions = loadModule('lib/subscriptions.js', {
		'./src/database': {
			sortedSetAdd: () => stored.promise,
			setAdd: async (...args) => { calls.push(args); },
		},
	});
	const result = subscriptions.add(1, { endpoint: 'https://push.invalid/new' });
	await tick();
	assert.deepEqual(calls, []);
	stored.resolve();
	await result;
	assert.deepEqual(calls, [['web-push:uids', 1]]);
});

test('remove deletes only the exact failed subscription and awaits registry cleanup', async () => {
	const cleanup = deferred();
	const subscription = { endpoint: 'https://push.invalid/1', keys: { auth: 'old-key' } };
	const removed = [];
	const subscriptions = loadModule('lib/subscriptions.js', {
		'./src/database': {
			sortedSetRemove: async (...args) => { removed.push(args); },
			sortedSetCard: async () => 0,
			setRemove: () => cleanup.promise,
		},
	});
	let settled = false;
	const result = subscriptions.remove(1, subscription).then(() => { settled = true; });
	await tick();
	assert.equal(settled, false);
	assert.deepEqual(removed, [['uid:1:web-push:subscriptions', JSON.stringify(subscription)]]);
	cleanup.resolve();
	await result;
});

test('a new subscription survives cleanup of an expired one, including its user registry', async () => {
	const old = { endpoint: 'https://push.invalid/1', keys: { auth: 'old-key' } };
	const replacement = { endpoint: 'https://push.invalid/1', keys: { auth: 'new-key' } };
	const devices = new Set([JSON.stringify(old)]);
	let indexed = true;
	const removingRegistry = deferred();
	const finishRemove = deferred();
	const subscriptions = loadModule('lib/subscriptions.js', {
		'./src/database': {
			sortedSetRemove: async (key, value) => { devices.delete(value); },
			sortedSetAdd: async (key, score, value) => { devices.add(value); },
			sortedSetCard: async () => devices.size,
			setAdd: async () => { indexed = true; },
			setRemove: async () => {
				removingRegistry.resolve();
				await finishRemove.promise;
				indexed = false;
			},
		},
	});
	const removal = subscriptions.remove(1, old);
	await removingRegistry.promise;
	await subscriptions.add(1, replacement);
	finishRemove.resolve();
	await removal;
	assert.deepEqual(Array.from(devices), [JSON.stringify(replacement)]);
	assert.equal(indexed, true);
});

test('an add completing after the final empty check restores the user registry', async () => {
	const storeNew = deferred();
	let count = 0;
	let indexed = true;
	const subscriptions = loadModule('lib/subscriptions.js', {
		'./src/database': {
			sortedSetRemove: async () => {},
			sortedSetAdd: async () => { await storeNew.promise; count = 1; },
			sortedSetCard: async () => count,
			setAdd: async () => { indexed = true; },
			setRemove: async () => { indexed = false; },
		},
	});
	const addition = subscriptions.add(1, { endpoint: 'https://push.invalid/new' });
	await subscriptions.remove(1, { endpoint: 'https://push.invalid/old' });
	assert.equal(indexed, false);
	storeNew.resolve();
	await addition;
	assert.equal(indexed, true);
	assert.equal(count, 1);
});
