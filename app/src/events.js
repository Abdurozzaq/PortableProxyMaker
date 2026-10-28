const { EventEmitter } = require('events');

// Process-wide bus: proxy instances publish here, the SSE endpoint subscribes.
const bus = new EventEmitter();
bus.setMaxListeners(0);

module.exports = bus;
