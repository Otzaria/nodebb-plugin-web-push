'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

exports.deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
};

exports.tick = () => new Promise(resolve => setImmediate(resolve));

// NodeBB supplies core services through require.main.require. Load the plugin
// with explicit services so the regression tests do not require a live forum.
exports.loadModule = (relativePath, services = {}, dependencies = {}) => {
	const filename = path.resolve(__dirname, '../..', relativePath);
	const localRequire = Module.createRequire(filename);
	const injectedRequire = name => (Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name));
	injectedRequire.main = {
		require(name) {
			if (!Object.hasOwn(services, name)) {
				throw new Error(`Unexpected NodeBB service: ${name}`);
			}
			return services[name];
		},
	};
	const module = { exports: {} };
	const wrapped = vm.runInThisContext(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename });
	wrapped(module.exports, injectedRequire, module, filename, path.dirname(filename));
	return module.exports;
};

exports.pluginFixture = (overrides = {}) => {
	const calls = { sent: [], removed: [], listed: [], settings: [], stored: [], expired: [], responses: [], errors: [], info: [] };
	const devices = overrides.devices || new Map([[1, new Set([{ endpoint: 'https://push.invalid/1' }])]]);
	const services = {
		nconf: { get: () => 'https://forum.invalid' },
		winston: {
			info: message => calls.info.push(message),
			error: message => calls.errors.push(message),
		},
		'./src/database': {
			setAdd: async (...args) => { calls.stored.push(args); },
			pexpire: async (...args) => { calls.expired.push(args); },
			getObjectsFields: async keys => keys.map(() => ({})),
			getSetsMembers: async keys => keys.map(() => Array.from(devices.keys())),
			...overrides.db,
		},
		'./src/user': {
			getMultipleUserSettings: async (uids) => {
				calls.settings.push(uids);
				return uids.map(() => ({ userLang: 'en-GB' }));
			},
			getSettings: async () => ({ userLang: 'en-GB' }),
		},
		'./src/meta': { config: {}, settings: { get: async () => ({ maxLength: 256 }) } },
		'./src/utils': { stripHTMLTags: value => value || '', generateUUID: () => 'test-nid' },
		'./src/translator': { translate: async () => 'ltr', translateKeys: async values => values },
		'./src/notifications': {
			findRelated: async () => [],
			getMultiple: async () => [],
			merge: values => values,
		},
		'./src/routes/helpers': {
			setupApiRoute: (router, method, route, middleware, handler) => { router[route] = handler; },
		},
	};
	const dependencies = {
		'web-push': {
			sendNotification: async (...args) => {
				calls.sent.push(args);
				if (overrides.send) {
					return overrides.send(...args);
				}
			},
		},
		validator: { unescape: value => value },
		'./lib/controllers': {},
		'./lib/subscriptions': {
			list: async (uids) => {
				calls.listed.push(uids);
				return new Map(uids.map(uid => [uid, devices.get(uid) || new Set()]));
			},
			remove: async (...args) => {
				calls.removed.push(args);
				if (overrides.remove) {
					return overrides.remove(...args);
				}
			},
		},
	};
	const plugin = exports.loadModule('library.js', services, dependencies);
	const notification = { nid: 'n1', bodyShort: 'Title', bodyLong: 'Body', path: '/topic/1' };
	return { plugin, calls, notification, devices, services };
};
