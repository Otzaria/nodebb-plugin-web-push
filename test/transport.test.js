'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const test = require('node:test');
const webPush = require('web-push');
const DeliveryQueue = require('../lib/delivery-queue');
const { deferred, tick } = require('./unit/helpers');

// This self-signed localhost certificate/key pair is public test data only.
const cert = fs.readFileSync(path.join(__dirname, 'fixtures/localhost-cert.pem'));
const key = fs.readFileSync(path.join(__dirname, 'fixtures/localhost-key.pem'));

async function localService(t, handle) {
	const server = https.createServer({ key, cert }, handle);
	const agent = new https.Agent({ ca: cert, keepAlive: false });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(async () => {
		agent.destroy();
		const closed = new Promise(resolve => server.close(resolve));
		server.closeAllConnections();
		await closed;
	});
	return { agent, server, endpoint: `https://127.0.0.1:${server.address().port}` };
}

test('the installed web-push client destroys an idle HTTPS connection on timeout', { timeout: 10000 }, async (t) => {
	const received = deferred();
	const disconnected = deferred();
	const { endpoint, agent } = await localService(t, (request) => {
		request.resume();
		request.socket.once('close', disconnected.resolve);
		received.resolve();
		// Deliberately leave the response pending.
	});
	const result = webPush.sendNotification({ endpoint }, undefined, { timeout: 200, agent });
	const rejection = assert.rejects(result, /Socket timeout/);
	await received.promise;
	await rejection;
	await disconnected.promise;
});

test('a timed-out request releases its worker and the next HTTPS delivery completes', { timeout: 10000 }, async (t) => {
	const received = deferred();
	const { endpoint, agent } = await localService(t, (request, response) => {
		request.resume();
		if (request.url === '/slow') {
			received.resolve();
		} else {
			response.writeHead(201);
			response.end('accepted');
		}
	});
	const queue = new DeliveryQueue({ concurrency: 1 });
	const events = [];
	const result = queue.run(['/slow', '/next'], async (route) => {
		events.push(`start:${route}`);
		try {
			await webPush.sendNotification({ endpoint: endpoint + route }, undefined, { timeout: 200, agent });
			events.push(`sent:${route}`);
		} catch (error) {
			assert.equal(route, '/slow');
			assert.match(error.message, /Socket timeout/);
			events.push(`timeout:${route}`);
		}
	});
	await received.promise;
	await tick();
	assert.deepEqual(events, ['start:/slow']);
	await result;
	assert.deepEqual(events, ['start:/slow', 'timeout:/slow', 'start:/next', 'sent:/next']);
	assert.equal(queue.active, 0);
});

test('the real client preserves expiry and retryable HTTP status responses', { timeout: 10000 }, async (t) => {
	const { endpoint, agent } = await localService(t, (request, response) => {
		request.resume();
		response.writeHead(request.url === '/gone' ? 410 : 429, { 'retry-after': '60' });
		response.end('provider response');
	});
	for (const [route, status] of [['/gone', 410], ['/busy', 429]]) {
		await assert.rejects(
			webPush.sendNotification({ endpoint: endpoint + route }, undefined, { timeout: 1000, agent }),
			(error) => {
				assert.equal(error.statusCode, status);
				assert.equal(error.headers['retry-after'], '60');
				assert.equal(error.body, 'provider response');
				return true;
			}
		);
	}
});
