'use strict';

const nconf = require.main.require('nconf');
const winston = require.main.require('winston');
const webPush = require('web-push');
const validator = require('validator');

const db = require.main.require('./src/database');
const user = require.main.require('./src/user');
const meta = require.main.require('./src/meta');
const utils = require.main.require('./src/utils');
const translator = require.main.require('./src/translator');
const notifications = require.main.require('./src/notifications');

const controllers = require('./lib/controllers');
const subscriptions = require('./lib/subscriptions');
const DeliveryQueue = require('./lib/delivery-queue');

const routeHelpers = require.main.require('./src/routes/helpers');

const plugin = {};
const deliveryQueue = new DeliveryQueue();
const recipientBatchSize = 100;
const pushOptions = { timeout: 15000 };

plugin.init = async (params) => {
	const { router, middleware/* , controllers */ } = params;
	const accountMiddlewares = [
		middleware.exposeUid,
		middleware.ensureLoggedIn,
		middleware.canViewUsers,
		middleware.checkAccountPermissions,
		middleware.buildAccountData,
	];

	await assertVapidConfiguration();

	routeHelpers.setupPageRoute(router, '/user/:userslug/web-push', accountMiddlewares, controllers.renderSettings);

	routeHelpers.setupAdminPageRoute(router, '/admin/plugins/web-push', controllers.renderAdminPage);
};

plugin.appendConfig = async (config) => {
	const { publicKey } = await meta.settings.get('web-push');
	config['web-push'] = {
		vapidKey: publicKey,
	};

	return config;
};

plugin.registerServiceWorker = async (data) => {
	const { scripts } = data;
	scripts.add(`nodebb-plugin-web-push/static/web-push.js`);
	return data;
};

async function assertVapidConfiguration() {
	let { publicKey, privateKey } = await meta.settings.get('web-push');
	if (!publicKey || !privateKey) {
		winston.warn('[plugins/web-push] VAPID key pair not found or invalid, regenerating.');
		({ publicKey, privateKey } = webPush.generateVAPIDKeys());
		await meta.settings.set('web-push', { publicKey, privateKey });
	} else {
		winston.info('[plugins/web-push] VAPID keys OK.');
	}

	webPush.setVapidDetails(
		nconf.get('url'),
		publicKey,
		privateKey
	);
}

plugin.addRoutes = async ({ router, middleware, helpers }) => {
	const middlewares = [
		middleware.ensureLoggedIn,
		// middleware.admin.checkPrivileges,
	];

	routeHelpers.setupApiRoute(router, 'post', '/web-push/subscription', middlewares, async (req, res) => {
		if (!req.uid) {
			return helpers.formatApiResponse(204, res);
		}

		const { subscription } = req.body;
		await subscriptions.add(req.uid, subscription);
		helpers.formatApiResponse(200, res);
	});

	routeHelpers.setupApiRoute(router, 'delete', '/web-push/subscription', middlewares, async (req, res) => {
		if (!req.uid) {
			return helpers.notAllowed(req, res);
		}

		const { subscription } = req.body;
		await subscriptions.remove(req.uid, subscription);
		helpers.formatApiResponse(200, res);
	});

	routeHelpers.setupApiRoute(router, 'post', '/web-push/test', middlewares, async (req, res) => {
		if (!req.uid) {
			return helpers.notAllowed(req, res);
		}

		const { userLang } = await user.getSettings(req.uid);
		const { subscription } = req.body;
		const payload = await constructPayload({
			nid: utils.generateUUID(),
			bodyShort: 'Test notification',
			bodyLong: 'This is a test message sent from NodeBB',
			path: `/me/web-push`,
		}, req.uid, userLang);
		await deliveryQueue.run([{ subscription, payload: JSON.stringify(payload) }], sendPush);
		helpers.formatApiResponse(200, res);
	});
};

plugin.addAdminNavigation = (header) => {
	header.plugins.push({
		route: '/plugins/web-push',
		icon: 'fa-tint',
		name: 'Push Notifications (via Push API)',
	});

	return header;
};

plugin.onNotificationPush = ({ notification, uidsNotified: uids }) =>
	deliveryQueue.run(notificationDeliveries(notification, uids), sendPush);

async function* notificationDeliveries(notification, uids) {
	const refKey = `web-push:nid:${notification.mergeId || notification.nid}:uids`;
	for (let offset = 0; offset < uids.length; offset += recipientBatchSize) {
		const batch = uids.slice(offset, offset + recipientBatchSize);
		const subs = await subscriptions.list(batch);
		const recipients = batch.filter(uid => subs.get(uid)?.size);
		if (!recipients.length) {
			continue;
		}
		const userSettings = await user.getMultipleUserSettings(recipients);

		// Save recipients by nid (for use by .rescind). Include expiry in completion.
		await db.setAdd(refKey, recipients);
		await db.pexpire(refKey, 1000 * 60 * 60 * 48);

		for (let idx = 0; idx < recipients.length; idx += 1) {
			const uid = recipients[idx];
			const payload = JSON.stringify(await constructPayload(notification, uid, userSettings[idx].userLang));
			for (const subscription of subs.get(uid)) {
				yield { uid, subscription, payload };
			}
		}
	}
}

plugin.onNotificationRescind = ({ nids }) =>
	deliveryQueue.run(rescindDeliveries(nids), sendPush);

async function* rescindDeliveries(nids) {
	const notificationKeys = nids.map(nid => `notifications:${nid}`);
	const notifications = await db.getObjectsFields(notificationKeys, ['mergeId']);

	// Favour mergeIds over nids, then eliminate dupes
	const tags = Array.from(new Set(nids.map((nid, idx) => notifications[idx]?.mergeId || nid)));
	for (const tag of tags) {
		const [recipients] = await db.getSetsMembers([`web-push:nid:${tag}:uids`]);
		const payload = JSON.stringify({ tag });
		for (let offset = 0; offset < recipients.length; offset += recipientBatchSize) {
			const subs = await subscriptions.list(recipients.slice(offset, offset + recipientBatchSize));
			for (const [uid, targets] of subs) {
				for (const subscription of targets) {
					yield { uid, subscription, payload };
				}
			}
		}
	}
}

async function sendPush({ uid, subscription, payload }) {
	try {
		// web-push destroys the request on socket timeout; keep the queue slot
		// until its promise settles instead of racing an uncancelled request.
		await webPush.sendNotification(subscription, payload, pushOptions);
	} catch (error) {
		if (uid === undefined) { // The test route reports send errors to its caller.
			throw error;
		}
		winston.info(`[plugins/web-push] Push failed: ${error.code}; ${error.message}; statusCode: ${error.statusCode}`);
		// Only the push service's explicit expiry responses invalidate a subscription.
		// Network failures, rate limits and server failures may be retried later.
		if (error.statusCode === 404 || error.statusCode === 410) {
			try {
				await subscriptions.remove(uid, subscription);
			} catch (cleanupError) {
				winston.error(`[plugins/web-push] Subscription cleanup failed: ${cleanupError.message}`);
			}
		}
	}
}

plugin.addProfileItem = (data) => {
	data.links.push({
		id: 'web-push',
		route: 'web-push',
		icon: 'fa-bell-o',
		name: '[[web-push:profile.label]]',
		visibility: {
			self: true,
			other: false,
			moderator: false,
			globalMod: false,
			admin: false,
			canViewInfo: false,
		},
	});

	return data;
};

async function constructPayload(notification, uid, lang) {
	let { maxLength, icon, badge } = await meta.settings.get('web-push');
	maxLength = parseInt(maxLength, 10) || 256;

	// i18n/rtl
	if (!lang) {
		lang = meta.config.defaultLang || 'en-GB';
	}
	const dir = await translator.translate('[[language:dir]]', lang);

	// Merge with related unread notifications
	if (notification.mergeId) {
		const related = await notifications.findRelated([notification.mergeId], `uid:${uid}:notifications:unread`);
		const merged = await notifications.getMultiple(related).then(notifications.merge);
		if (merged.length) {
			notification = merged.pop();
		}
	}

	const { nid, mergeId, bodyShort, bodyLong, path } = notification;

	let [title, body] = await translator.translateKeys([bodyShort, bodyLong], lang);
	([title, body] = [title, body].map(str => validator.unescape(utils.stripHTMLTags(str))));
	const tag = mergeId || nid;
	const url = `${nconf.get('url')}${path}`;

	// Handle empty bodyLong
	if (!bodyLong) {
		body = title;
		title = meta.config.title || 'NodeBB';
	}

	// Truncate body if needed
	if (body.length > maxLength) {
		body = `${body.slice(0, maxLength)}…`;
	}

	icon = icon || `${nconf.get('url')}/apple-touch-icon`;
	if (!badge) { // badge fallbacks
		badge = `${nconf.get('url')}${meta.config['brand:maskableIcon'] || '/apple-touch-icon'}`;
	}

	return {
		title,
		body,
		tag,
		lang,
		dir,
		data: { url, icon, badge },
	};
}

module.exports = plugin;
