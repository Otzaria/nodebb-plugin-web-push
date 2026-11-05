'use strict';

// Keep one lazy iterator per notification, rather than one promise per device.
// The limit is shared by every caller of this queue, including rescinds.
class DeliveryQueue {
	constructor({ concurrency = 8, capacity = 64 } = {}) {
		if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
			!Number.isSafeInteger(capacity) || capacity < 1) {
			throw new RangeError('Queue concurrency and capacity must be positive integers');
		}
		this.concurrency = concurrency;
		this.capacity = capacity;
		this.entries = [];
		this.active = 0;
		this.size = 0;
	}

	run(items, worker) {
		if (this.size >= this.capacity) {
			const error = new Error('Web push delivery queue is full');
			error.code = 'WEB_PUSH_QUEUE_FULL';
			return Promise.reject(error);
		}

		const iterator = items[Symbol.asyncIterator] ? items[Symbol.asyncIterator]() : items[Symbol.iterator]();
		return new Promise((resolve, reject) => {
			this.size += 1;
			this.entries.push({ iterator, worker, resolve, reject, active: 0, done: false, failed: false });
			this.schedule();
		});
	}

	schedule() {
		while (this.active < this.concurrency && this.entries.length) {
			const entry = this.entries.shift();
			this.entries.push(entry); // Round-robin across notifications.
			this.active += 1;
			entry.active += 1;
			this.process(entry);
		}
	}

	async process(entry) {
		try {
			const item = await entry.iterator.next();
			if (item.done) {
				entry.done = true;
			} else {
				await entry.worker(item.value);
			}
		} catch (error) {
			if (!entry.failed) {
				entry.error = error;
				entry.failed = true;
			}
			entry.done = true;
		} finally {
			this.active -= 1;
			entry.active -= 1;
			if (entry.done) {
				this.entries = this.entries.filter(item => item !== entry);
				if (!entry.active) {
					try {
						if (entry.failed && entry.iterator.return) {
							await entry.iterator.return();
						}
					} catch (error) {
						if (!entry.failed) {
							entry.error = error;
							entry.failed = true;
						}
					}
					this.size -= 1;
					if (entry.failed) {
						entry.reject(entry.error);
					} else {
						entry.resolve();
					}
				}
			}
			this.schedule();
		}
	}
}

module.exports = DeliveryQueue;
