const fs = require('fs');

// 1. send-gate.ts
let sendGate = fs.readFileSync('src/lib/services/messaging/send-gate.ts', 'utf8');
sendGate = sendGate.replaceAll('MessageStatus.QUEUED, ', '');
fs.writeFileSync('src/lib/services/messaging/send-gate.ts', sendGate, 'utf8');

// 2. messaging-service.ts
let msg = fs.readFileSync('src/lib/services/messaging/messaging-service.ts', 'utf8');
msg = msg.replaceAll('MessageStatus.QUEUED, ', '');
fs.writeFileSync('src/lib/services/messaging/messaging-service.ts', msg, 'utf8');

// 3. bulk-messaging-service.ts
let bulk = fs.readFileSync('src/lib/services/messaging/bulk-messaging-service.ts', 'utf8');
bulk = bulk.replaceAll('"QUEUED", ', '');
bulk = bulk.replace(/select:\r?\n\s+lead:\s*\{/g, 'include:\n      lead: {');
fs.writeFileSync('src/lib/services/messaging/bulk-messaging-service.ts', bulk, 'utf8');

console.log('Applied QUEUED and include fixes');

