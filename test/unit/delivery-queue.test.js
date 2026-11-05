'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const DeliveryQueue = require('../../lib/delivery-queue');
const { deferred, tick } = require('./helpers');

test('streams recipients lazily with one global concurrency limit across calls', async () => {
	const queue = new DeliveryQueue({ concurrency: 3 });
	const gate = deferred();
	let generated = 0;
	let active = 0;
	let peak = 0;
	let completed = 0;
	function* recipients(count) {
		for (let i = 0; i < count; i += 1) {
			generated += 1;
			yield i;
		}
	}
	const send = async () => {
		active += 1;
		peak = Math.max(peak, active);
		await gate.promise;
		active -= 1;
		completed += 1;
	};
	const first = queue.run(recipients(1000), send);
	const second = queue.run(recipients(200), send);
	await tick();
	assert.equal(generated, 3);
	assert.equal(peak, 3);
	assert.equal(completed, 0);
	gate.resolve();
	await Promise.all([first, second]);
	assert.equal(completed, 1200);
	assert.equal(generated, 1200);
	assert.equal(peak, 3);
	assert.equal(queue.size, 0);
	assert.equal(queue.active, 0);
});

test('rejects overload before advancing the new source and admits work after draining', async () => {
	const queue = new DeliveryQueue({ concurrency: 1, capacity: 2 });
	const gate = deferred();
	let started = false;
	function* overflow() {
		started = true;
		yield 1;
	}
	const first = queue.run([1], () => gate.promise);
	const second = queue.run([2], () => gate.promise);
	await assert.rejects(queue.run(overflow(), () => gate.promise), { code: 'WEB_PUSH_QUEUE_FULL' });
	assert.equal(started, false);
	assert.equal(queue.size, 2);
	gate.resolve();
	await Promise.all([first, second]);
	await queue.run([3], async () => {});
	assert.equal(queue.size, 0);
});

test('a producer failure waits for every in-flight delivery before rejecting', async () => {
	const queue = new DeliveryQueue({ concurrency: 3 });
	const gate = deferred();
	const failure = new Error('recipient database unavailable');
	let completed = 0;
	let settled = false;
	function* items() {
		yield 1;
		yield 2;
		throw failure;
	}
	const result = queue.run(items(), async () => {
		await gate.promise;
		completed += 1;
	});
	const rejection = assert.rejects(result, failure).then(() => { settled = true; });
	await tick();
	assert.equal(settled, false);
	gate.resolve();
	await rejection;
	assert.equal(completed, 2);
	assert.equal(queue.active, 0);
	assert.equal(queue.size, 0);
});

test('worker failure closes the source and waits for asynchronous cleanup', async () => {
	const queue = new DeliveryQueue({ concurrency: 1 });
	const cleanup = deferred();
	let closed = false;
	let settled = false;
	async function* items() {
		try {
			yield 1;
			yield 2;
		} finally {
			await cleanup.promise;
			closed = true;
		}
	}
	const result = queue.run(items(), async () => { throw new Error('send failed'); });
	const rejection = assert.rejects(result, /send failed/).then(() => { settled = true; });
	await tick();
	assert.equal(settled, false);
	assert.equal(queue.size, 1);
	cleanup.resolve();
	await rejection;
	assert.equal(closed, true);
	assert.equal(queue.size, 0);
	await queue.run([], async () => {});
});

test('preserves a falsy rejection instead of resolving successfully', async () => {
	const queue = new DeliveryQueue();
	let rejected = false;
	await queue.run([1], () => Promise.reject(undefined)).then(
		() => assert.fail('must reject'),
		(error) => {
			rejected = true;
			assert.equal(error, undefined);
		}
	);
	assert.equal(rejected, true);
});

test('rejects invalid queue limits', () => {
	for (const value of [0, -1, 1.5, Infinity, NaN]) {
		assert.throws(() => new DeliveryQueue({ concurrency: value }), RangeError);
		assert.throws(() => new DeliveryQueue({ capacity: value }), RangeError);
	}
});
