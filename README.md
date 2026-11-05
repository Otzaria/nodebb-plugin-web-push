# Push Notifications (via Push API) Plugin for NodeBB

This plugin adds push notification functionality for NodeBB via the in-browser [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API).

Once installed, users are able to configure their push notification subscription settings from their account profile.

## Installation

    npm install nodebb-plugin-web-push

## Delivery limits

Each NodeBB process shares one delivery queue across notifications, rescinds,
and the test endpoint. It runs at most 8 deliveries at a time and admits at most
64 notification events (active and waiting combined). Recipients are read in
batches of 100 and device deliveries are generated lazily. When the event queue
is full, the hook rejects with `WEB_PUSH_QUEUE_FULL` before processing the new
event; it does not silently discard individual devices or create an unbounded
backlog. The queue is in memory, not durable storage.

Push and rescind hooks return a promise that settles after their deliveries and
subscription cleanup finish. A recipient lookup failure rejects only after
already-started deliveries settle. The web-push client's 15-second socket
inactivity timeout destroys the underlying request before the worker is reused.
This is an inactivity timeout, not a total response deadline.

Only HTTP 404 and 410 responses remove the exact failed subscription. Rate
limits, authentication/server errors and network failures retain subscriptions
for later notifications. Failed requests are logged; no automatic retry is added
because a timeout can occur after the push service has accepted a notification.

## Tests

`npm test` runs standalone queue, hook and subscription regression tests using
Node's built-in test runner and injected NodeBB services. `npm run test:integration`
tests the installed web-push client's timeout against a local HTTPS server.
The original `test/index.js` also remains available in NodeBB's test harness.
