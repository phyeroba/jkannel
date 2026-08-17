/* Sample operational estate: the East African mobile networks a Kamex gateway
   binds to, grouped by country/territory. Figures are representative, not live. Health semantics follow section 3.3
   of the specification — healthy / degraded / critical / unknown, and unknown is
   never rendered as healthy. */

export const CARRIERS = [
  { id: 'mtn-ug', country: 'Uganda', cc: 'UG', name: 'MTN Uganda', mcc: '641', mnc: '10', prefixes: '077, 078, 076, 039', smscs: 2, sessionsUp: 3, sessionsTotal: 4, tps: 312, capacity: 400, queue: 1284, queueAge: '00:06:48', delivery: 96.2, p95: '11.2s', rejects: 2.1, health: 'degraded', lastEvent: 'throttled 01:41:07' },
  { id: 'airtel-ug', country: 'Uganda', cc: 'UG', name: 'Airtel Uganda', mcc: '641', mnc: '01', prefixes: '070, 075, 020', smscs: 2, sessionsUp: 4, sessionsTotal: 4, tps: 188, capacity: 300, queue: 96, queueAge: '00:00:11', delivery: 98.8, p95: '6.4s', rejects: 0.4, health: 'healthy', lastEvent: 'rebind 22:14:02' },
  { id: 'lyca-ug', country: 'Uganda', cc: 'UG', name: 'Lycamobile Uganda', mcc: '641', mnc: '33', prefixes: '072', smscs: 1, sessionsUp: 1, sessionsTotal: 1, tps: 24, capacity: 50, queue: 0, queueAge: '—', delivery: 97.8, p95: '8.9s', rejects: 0.9, health: 'healthy', lastEvent: 'bind 19:02:44' },
  { id: 'utl-ug', country: 'Uganda', cc: 'UG', name: 'UTL', mcc: '641', mnc: '11', prefixes: '071, 041', smscs: 1, sessionsUp: 0, sessionsTotal: 2, tps: 0, capacity: 60, queue: 412, queueAge: '00:21:03', delivery: null, p95: '—', rejects: null, health: 'critical', lastEvent: 'disconnect 01:19:58' },
  { id: 'smart-ug', country: 'Uganda', cc: 'UG', name: 'Smart Telecom', mcc: '641', mnc: '22', prefixes: '073', smscs: 1, sessionsUp: 1, sessionsTotal: 1, tps: 6, capacity: 20, queue: 3, queueAge: '00:00:41', delivery: 94.1, p95: '14.6s', rejects: 3.8, health: 'degraded', lastEvent: 'throttled 00:58:12' },
  { id: 'safaricom-ke', country: 'Kenya', cc: 'KE', name: 'Safaricom Kenya', mcc: '639', mnc: '02', prefixes: '070, 071, 072, 079', smscs: 2, sessionsUp: 3, sessionsTotal: 3, tps: 264, capacity: 350, queue: 41, queueAge: '00:00:08', delivery: 98.4, p95: '5.8s', rejects: 0.6, health: 'healthy', lastEvent: 'bind 20:41:12' },
  { id: 'vodacom-tz', country: 'Tanzania', cc: 'TZ', name: 'Vodacom Tanzania', mcc: '640', mnc: '04', prefixes: '074, 075, 076', smscs: 1, sessionsUp: 1, sessionsTotal: 2, tps: 88, capacity: 150, queue: 620, queueAge: '00:04:22', delivery: 93.6, p95: '17.4s', rejects: 4.2, health: 'degraded', lastEvent: 'throttle 01:28:19' },
  { id: 'smile-ug', country: 'Uganda', cc: 'UG', name: 'Smile Telecom', mcc: '641', mnc: '18', prefixes: '074', smscs: 1, sessionsUp: 0, sessionsTotal: 1, tps: null, capacity: 20, queue: null, queueAge: '—', delivery: null, p95: '—', rejects: null, health: 'unknown', lastEvent: 'telemetry stale 00:12:31' },
];

export const SMSCS = [
  { id: 'mtn_ug_trx1', country: 'Uganda', cc: 'UG', carrier: 'MTN Uganda', carrierId: 'mtn-ug', protocol: 'SMPP 3.4', state: 'degraded', sessionsUp: 2, sessionsTotal: 2, tpsOut: 212, tpsIn: 18, capacity: 250, queue: 1284, queueAge: '00:06:48', delivery: 95.8, dlrLatency: '11.2s', lastEvent: 'throttle 01:41:07', suspended: false },
  { id: 'mtn_ug_trx2', country: 'Uganda', cc: 'UG', carrier: 'MTN Uganda', carrierId: 'mtn-ug', protocol: 'SMPP 3.4', state: 'connected', sessionsUp: 1, sessionsTotal: 2, tpsOut: 100, tpsIn: 4, capacity: 150, queue: 0, queueAge: '—', delivery: 96.9, dlrLatency: '9.4s', lastEvent: 'rebind 01:12:40', suspended: false },
  { id: 'airtel_ug_trx1', country: 'Uganda', cc: 'UG', carrier: 'Airtel Uganda', carrierId: 'airtel-ug', protocol: 'SMPP 3.4', state: 'connected', sessionsUp: 2, sessionsTotal: 2, tpsOut: 128, tpsIn: 22, capacity: 200, queue: 96, queueAge: '00:00:11', delivery: 98.9, dlrLatency: '6.1s', lastEvent: 'bind 22:14:02', suspended: false },
  { id: 'airtel_ug_trx2', country: 'Uganda', cc: 'UG', carrier: 'Airtel Uganda', carrierId: 'airtel-ug', protocol: 'SMPP 3.4', state: 'connected', sessionsUp: 2, sessionsTotal: 2, tpsOut: 60, tpsIn: 9, capacity: 100, queue: 0, queueAge: '—', delivery: 98.6, dlrLatency: '6.8s', lastEvent: 'bind 22:14:05', suspended: false },
  { id: 'lyca_ug_tx', country: 'Uganda', cc: 'UG', carrier: 'Lycamobile Uganda', carrierId: 'lyca-ug', protocol: 'SMPP 3.4', state: 'connected', sessionsUp: 1, sessionsTotal: 1, tpsOut: 24, tpsIn: 0, capacity: 50, queue: 0, queueAge: '—', delivery: 97.8, dlrLatency: '8.9s', lastEvent: 'bind 19:02:44', suspended: false },
  { id: 'utl_ug_trx', country: 'Uganda', cc: 'UG', carrier: 'UTL', carrierId: 'utl-ug', protocol: 'SMPP 3.4', state: 'disconnected', sessionsUp: 0, sessionsTotal: 2, tpsOut: 0, tpsIn: 0, capacity: 60, queue: 412, queueAge: '00:21:03', delivery: null, dlrLatency: '—', lastEvent: 'disconnect 01:19:58', suspended: false },
  { id: 'smart_ug_tx', country: 'Uganda', cc: 'UG', carrier: 'Smart Telecom', carrierId: 'smart-ug', protocol: 'SMPP 3.4', state: 'degraded', sessionsUp: 1, sessionsTotal: 1, tpsOut: 6, tpsIn: 0, capacity: 20, queue: 3, queueAge: '00:00:41', delivery: 94.1, dlrLatency: '14.6s', lastEvent: 'throttle 00:58:12', suspended: false },
  { id: 'safaricom_ke_trx1', country: 'Kenya', cc: 'KE', carrier: 'Safaricom Kenya', carrierId: 'safaricom-ke', protocol: 'SMPP 3.4', state: 'connected', sessionsUp: 2, sessionsTotal: 2, tpsOut: 186, tpsIn: 31, capacity: 250, queue: 41, queueAge: '00:00:08', delivery: 98.6, dlrLatency: '5.4s', lastEvent: 'bind 20:41:12', suspended: false },
  { id: 'safaricom_ke_trx2', country: 'Kenya', cc: 'KE', carrier: 'Safaricom Kenya', carrierId: 'safaricom-ke', protocol: 'SMPP 3.4', state: 'connected', sessionsUp: 1, sessionsTotal: 1, tpsOut: 78, tpsIn: 12, capacity: 100, queue: 0, queueAge: '—', delivery: 98.1, dlrLatency: '6.2s', lastEvent: 'bind 20:41:14', suspended: false },
  { id: 'vodacom_tz_trx', country: 'Tanzania', cc: 'TZ', carrier: 'Vodacom Tanzania', carrierId: 'vodacom-tz', protocol: 'SMPP 3.4', state: 'degraded', sessionsUp: 1, sessionsTotal: 2, tpsOut: 88, tpsIn: 6, capacity: 150, queue: 620, queueAge: '00:04:22', delivery: 93.6, dlrLatency: '17.4s', lastEvent: 'throttle 01:28:19', suspended: false },
  { id: 'smile_ug_tx', country: 'Uganda', cc: 'UG', carrier: 'Smile Telecom', carrierId: 'smile-ug', protocol: 'SMPP 3.4', state: 'suspended', sessionsUp: 0, sessionsTotal: 1, tpsOut: 0, tpsIn: 0, capacity: 20, queue: 0, queueAge: '—', delivery: null, dlrLatency: '—', lastEvent: 'suspended by operator 00:12:31', suspended: true },
];

export const SESSIONS = [
  { id: 'TRX-01', smsc: 'mtn_ug_trx1', carrier: 'MTN Uganda', bind: 'BOUND_TRX', endpoint: 'smpp.mtn.co.ug:2775', uptime: '02:18:44', lastActivity: '01:41:12', enquireRtt: '412 ms', enquireMissed: 0, submit: 184902, submitResp: 184771, deliver: 41208, deliverResp: 41208, nack: 131, latencyP95: '980 ms', reconnects: 0, timeouts: 2, topError: 'ESME_RTHROTTLED', health: 'degraded' },
  { id: 'TRX-02', smsc: 'mtn_ug_trx1', carrier: 'MTN Uganda', bind: 'BOUND_TRX', endpoint: 'smpp.mtn.co.ug:2775', uptime: '00:04:12', lastActivity: '01:41:11', enquireRtt: '388 ms', enquireMissed: 1, submit: 91044, submitResp: 90980, deliver: 20114, deliverResp: 20114, nack: 64, latencyP95: '1.4s', reconnects: 7, timeouts: 11, topError: 'ESME_RTHROTTLED', health: 'degraded' },
  { id: 'TRX-03', smsc: 'mtn_ug_trx2', carrier: 'MTN Uganda', bind: 'BOUND_TRX', endpoint: 'smpp2.mtn.co.ug:2775', uptime: '00:29:02', lastActivity: '01:41:09', enquireRtt: '204 ms', enquireMissed: 0, submit: 60218, submitResp: 60218, deliver: 14002, deliverResp: 14002, nack: 0, latencyP95: '410 ms', reconnects: 1, timeouts: 0, topError: '—', health: 'healthy' },
  { id: 'TRX-04', smsc: 'airtel_ug_trx1', carrier: 'Airtel Uganda', bind: 'BOUND_TRX', endpoint: 'smpp.airtel.co.ug:2775', uptime: '03:27:10', lastActivity: '01:41:12', enquireRtt: '96 ms', enquireMissed: 0, submit: 57401, submitResp: 57401, deliver: 22140, deliverResp: 22140, nack: 0, latencyP95: '240 ms', reconnects: 0, timeouts: 0, topError: '—', health: 'healthy' },
  { id: 'TX-05', smsc: 'lyca_ug_tx', carrier: 'Lycamobile Uganda', bind: 'BOUND_TX', endpoint: '41.190.12.9:2775', uptime: '06:38:26', lastActivity: '01:40:58', enquireRtt: '148 ms', enquireMissed: 0, submit: 12681, submitResp: 12681, deliver: 0, deliverResp: 0, nack: 0, latencyP95: '320 ms', reconnects: 0, timeouts: 0, topError: '—', health: 'healthy' },
  { id: 'TRX-06', smsc: 'utl_ug_trx', carrier: 'UTL', bind: 'UNBOUND', endpoint: 'smpp.utl.co.ug:2775', uptime: '—', lastActivity: '01:19:58', enquireRtt: '—', enquireMissed: 6, submit: 8204, submitResp: 8180, deliver: 1902, deliverResp: 1902, nack: 24, latencyP95: '—', reconnects: 14, timeouts: 22, topError: 'ESME_RSUBMITFAIL', health: 'critical' },
  { id: 'TX-07', smsc: 'smart_ug_tx', carrier: 'Smart Telecom', bind: 'BOUND_TX', endpoint: '197.239.4.88:2775', uptime: '01:02:19', lastActivity: '01:40:44', enquireRtt: '640 ms', enquireMissed: 2, submit: 2044, submitResp: 2038, deliver: 0, deliverResp: 0, nack: 6, latencyP95: '2.1s', reconnects: 3, timeouts: 4, topError: 'ESME_RTHROTTLED', health: 'degraded' },
  { id: 'TRX-09', smsc: 'safaricom_ke_trx1', carrier: 'Safaricom Kenya', bind: 'BOUND_TRX', endpoint: 'smpp.safaricom.co.ke:2775', uptime: '04:59:31', lastActivity: '01:41:10', enquireRtt: '128 ms', enquireMissed: 0, submit: 96410, submitResp: 96410, deliver: 30188, deliverResp: 30188, nack: 0, latencyP95: '280 ms', reconnects: 0, timeouts: 0, topError: '—', health: 'healthy' },
  { id: 'TRX-10', smsc: 'safaricom_ke_trx1', carrier: 'Safaricom Kenya', bind: 'BOUND_TRX', endpoint: 'smpp.safaricom.co.ke:2775', uptime: '04:59:28', lastActivity: '01:41:11', enquireRtt: '134 ms', enquireMissed: 0, submit: 88204, submitResp: 88204, deliver: 28740, deliverResp: 28740, nack: 0, latencyP95: '300 ms', reconnects: 0, timeouts: 0, topError: '—', health: 'healthy' },
  { id: 'TRX-11', smsc: 'safaricom_ke_trx2', carrier: 'Safaricom Kenya', bind: 'BOUND_TRX', endpoint: 'smpp2.safaricom.co.ke:2775', uptime: '04:58:02', lastActivity: '01:41:08', enquireRtt: '142 ms', enquireMissed: 0, submit: 40118, submitResp: 40118, deliver: 12004, deliverResp: 12004, nack: 0, latencyP95: '340 ms', reconnects: 1, timeouts: 0, topError: '—', health: 'healthy' },
  { id: 'TRX-12', smsc: 'vodacom_tz_trx', carrier: 'Vodacom Tanzania', bind: 'BOUND_TRX', endpoint: 'smpp.vodacom.co.tz:2775', uptime: '00:41:07', lastActivity: '01:41:02', enquireRtt: '720 ms', enquireMissed: 2, submit: 30442, submitResp: 30310, deliver: 8820, deliverResp: 8820, nack: 132, latencyP95: '2.4s', reconnects: 4, timeouts: 7, topError: 'ESME_RTHROTTLED', health: 'degraded' },
  { id: 'TRX-13', smsc: 'vodacom_tz_trx', carrier: 'Vodacom Tanzania', bind: 'UNBOUND', endpoint: 'smpp.vodacom.co.tz:2775', uptime: '—', lastActivity: '01:28:19', enquireRtt: '—', enquireMissed: 4, submit: 11208, submitResp: 11160, deliver: 3011, deliverResp: 3011, nack: 48, latencyP95: '—', reconnects: 9, timeouts: 13, topError: 'ESME_RTHROTTLED', health: 'critical' },
  { id: 'TX-08', smsc: 'smile_ug_tx', carrier: 'Smile Telecom', bind: 'CLOSED', endpoint: '102.68.44.19:2775', uptime: '—', lastActivity: '00:12:31', enquireRtt: '—', enquireMissed: 0, submit: 0, submitResp: 0, deliver: 0, deliverResp: 0, nack: 0, latencyP95: '—', reconnects: 0, timeouts: 0, topError: '—', health: 'unknown' },
];

export const QUEUES = [
  { id: 'q-mtn-trx1', destination: 'mtn_ug_trx1', carrier: 'MTN Uganda', route: 'MTN national', depth: 1284, oldest: '00:06:48', ingress: 212, egress: 188, growth: 24, retries: 96, expired: 4, drain: '00:08:54', drainReliable: true },
  { id: 'q-utl-trx', destination: 'utl_ug_trx', carrier: 'UTL', depth: 412, route: 'UTL national', oldest: '00:21:03', ingress: 8, egress: 0, growth: 8, retries: 412, expired: 18, drain: 'unavailable', drainReliable: false },
  { id: 'q-airtel-trx1', destination: 'airtel_ug_trx1', carrier: 'Airtel Uganda', route: 'Airtel national', depth: 96, oldest: '00:00:11', ingress: 128, egress: 130, growth: -2, retries: 2, expired: 0, drain: '00:00:44', drainReliable: true },
  { id: 'q-vodacom-tz', destination: 'vodacom_tz_trx', carrier: 'Vodacom Tanzania', route: 'Vodacom national', depth: 620, oldest: '00:04:22', ingress: 88, egress: 74, growth: 14, retries: 148, expired: 6, drain: '00:44:17', drainReliable: true },
  { id: 'q-safaricom-ke1', destination: 'safaricom_ke_trx1', carrier: 'Safaricom Kenya', route: 'Safaricom national', depth: 41, oldest: '00:00:08', ingress: 186, egress: 188, growth: -2, retries: 1, expired: 0, drain: '00:00:21', drainReliable: true },
  { id: 'q-smart-tx', destination: 'smart_ug_tx', carrier: 'Smart Telecom', route: 'Smart national', depth: 3, oldest: '00:00:41', ingress: 6, egress: 6, growth: 0, retries: 0, expired: 0, drain: '00:00:02', drainReliable: true },
];

export const ROUTES = [
  { id: 'r-mtn', name: 'MTN national', match: 'prefix 25677, 25678, 25676, 25639', primary: 'mtn_ug_trx1', secondary: 'mtn_ug_trx2', emergency: 'airtel_ug_trx1', active: 'mtn_ug_trx1', mode: 'automatic', tps: 212, queue: 1284, lastTransition: '—', reason: '—' },
  { id: 'r-airtel', name: 'Airtel national', match: 'prefix 25670, 25675, 25620', primary: 'airtel_ug_trx1', secondary: 'airtel_ug_trx2', emergency: '—', active: 'airtel_ug_trx1', mode: 'automatic', tps: 188, queue: 96, lastTransition: '—', reason: '—' },
  { id: 'r-utl', name: 'UTL national', match: 'prefix 25671, 25641', primary: 'utl_ug_trx', secondary: '—', emergency: '—', active: 'none', mode: 'automatic', tps: 0, queue: 412, lastTransition: '01:19:58', reason: 'primary unavailable, no alternate configured' },
  { id: 'r-lyca', name: 'Lycamobile national', match: 'prefix 25672', primary: 'lyca_ug_tx', secondary: '—', emergency: '—', active: 'lyca_ug_tx', mode: 'automatic', tps: 24, queue: 0, lastTransition: '—', reason: '—' },
  { id: 'r-smart', name: 'Smart national', match: 'prefix 25673', primary: 'smart_ug_tx', secondary: '—', emergency: '—', active: 'smart_ug_tx', mode: 'manual', tps: 6, queue: 3, lastTransition: '00:58:40', reason: 'operator override during carrier throttling' },
  { id: 'r-safaricom', name: 'Safaricom national', match: 'prefix 25470, 25471, 25472, 25479', primary: 'safaricom_ke_trx1', secondary: 'safaricom_ke_trx2', emergency: '—', active: 'safaricom_ke_trx1', mode: 'automatic', tps: 264, queue: 41, lastTransition: '—', reason: '—' },
  { id: 'r-vodacom', name: 'Vodacom national', match: 'prefix 25574, 25575, 25576', primary: 'vodacom_tz_trx', secondary: '—', emergency: '—', active: 'vodacom_tz_trx', mode: 'automatic', tps: 88, queue: 620, lastTransition: '01:28:19', reason: '—' },
  { id: 'r-smile', name: 'Smile national', match: 'prefix 25674', primary: 'smile_ug_tx', secondary: '—', emergency: '—', active: 'none', mode: 'automatic', tps: 0, queue: 0, lastTransition: '00:12:31', reason: 'target suspended by operator' },
];

export const PREFIX_MAP = [
  { prefix: '25677', carrier: 'MTN Uganda', route: 'MTN national' },
  { prefix: '25678', carrier: 'MTN Uganda', route: 'MTN national' },
  { prefix: '25676', carrier: 'MTN Uganda', route: 'MTN national' },
  { prefix: '25639', carrier: 'MTN Uganda', route: 'MTN national' },
  { prefix: '25670', carrier: 'Airtel Uganda', route: 'Airtel national' },
  { prefix: '25675', carrier: 'Airtel Uganda', route: 'Airtel national' },
  { prefix: '25620', carrier: 'Airtel Uganda', route: 'Airtel national' },
  { prefix: '25671', carrier: 'UTL', route: 'UTL national' },
  { prefix: '25641', carrier: 'UTL', route: 'UTL national' },
  { prefix: '25672', carrier: 'Lycamobile Uganda', route: 'Lycamobile national' },
  { prefix: '25673', carrier: 'Smart Telecom', route: 'Smart national' },
  { prefix: '25470', carrier: 'Safaricom Kenya', route: 'Safaricom national' },
  { prefix: '25471', carrier: 'Safaricom Kenya', route: 'Safaricom national' },
  { prefix: '25472', carrier: 'Safaricom Kenya', route: 'Safaricom national' },
  { prefix: '25479', carrier: 'Safaricom Kenya', route: 'Safaricom national' },
  { prefix: '25574', carrier: 'Vodacom Tanzania', route: 'Vodacom national' },
  { prefix: '25575', carrier: 'Vodacom Tanzania', route: 'Vodacom national' },
  { prefix: '25576', carrier: 'Vodacom Tanzania', route: 'Vodacom national' },
  { prefix: '25674', carrier: 'Smile Telecom', route: 'Smile national' },
];

export const ALERTS = [
  { id: 'ALR-4471', severity: 'critical', category: 'Availability', summary: 'UTL SMSC disconnected — both sessions unbound', object: 'utl_ug_trx', started: '01:19:58', duration: '21m', impact: '412 messages queued, 0 egress', state: 'active', ack: null, occurrences: 1 },
  { id: 'ALR-4470', severity: 'warning', category: 'Capacity', summary: 'MTN carrier throttling — ESME_RTHROTTLED rate rising', object: 'mtn_ug_trx1', started: '01:38:12', duration: '3m', impact: '24 msg/s net queue growth', state: 'active', ack: null, occurrences: 18 },
  { id: 'ALR-4469', severity: 'warning', category: 'Connectivity quality', summary: 'Session flapping on TRX-02 — 7 reconnects in 30m', object: 'TRX-02', started: '01:11:40', duration: '29m', impact: 'intermittent submit failures', state: 'acknowledged', ack: 'operator 01:14:02', occurrences: 7 },
  { id: 'ALR-4468', severity: 'warning', category: 'Delivery quality', summary: 'Smart Telecom delivery rate below 95%', object: 'smart_ug_tx', started: '00:58:12', duration: '43m', impact: '5.9% of traffic failing', state: 'acknowledged', ack: 'operator 01:02:19', occurrences: 3 },
  { id: 'ALR-4467', severity: 'warning', category: 'Telemetry', summary: 'Telemetry stale for Smile Telecom — health reported unknown', object: 'smile-ug', started: '00:12:31', duration: '1h 29m', impact: 'health cannot be determined', state: 'active', ack: null, occurrences: 1 },
  { id: 'ALR-4466', severity: 'info', category: 'Availability', summary: 'Airtel SMSC rebound after scheduled carrier maintenance', object: 'airtel_ug_trx1', started: '2026-08-14 22:14:02', duration: '4m', impact: 'none observed', state: 'recovered', ack: 'operator 22:16:40', occurrences: 1 },
];

export const SMPP_ERRORS = [
  { code: '0x00000058', name: 'ESME_RTHROTTLED', meaning: 'The carrier is rejecting submissions because you exceeded its permitted rate.', count: 1842, rate: '4.1/s', smsc: 'mtn_ug_trx1', session: 'TRX-01', first: '01:38:12', last: '01:41:12', trend: 'rising', guidance: 'Compare submitted TPS against the agreed carrier ceiling; reduce rate or reroute overflow before escalating.' },
  { code: '0x00000045', name: 'ESME_RSUBMITFAIL', meaning: 'The SMSC accepted the bind but failed the submit for an internal reason.', count: 214, rate: '0.4/s', smsc: 'utl_ug_trx', session: 'TRX-06', first: '01:19:58', last: '01:40:02', trend: 'rising', guidance: 'Usually carrier-side. Confirm the bind is genuinely up and raise with the carrier NOC with these timestamps.' },
  { code: '0x0000000B', name: 'ESME_RINVDSTADR', meaning: 'The destination address was rejected as invalid by the carrier.', count: 96, rate: '0.2/s', smsc: 'mtn_ug_trx1', session: 'TRX-01', first: '00:41:02', last: '01:39:44', trend: 'steady', guidance: 'Check number normalisation for the affected prefix — this is usually a source-data problem, not a carrier fault.' },
  { code: '0x00000014', name: 'ESME_RMSGQFUL', meaning: 'The carrier message queue is full.', count: 41, rate: '0.1/s', smsc: 'smart_ug_tx', session: 'TX-07', first: '00:58:12', last: '01:36:18', trend: 'falling', guidance: 'Back off submissions and watch the queue drain before resuming full rate.' },
  { code: '0x00000005', name: 'ESME_RALYBND', meaning: 'A bind was attempted on a session that is already bound.', count: 7, rate: '—', smsc: 'mtn_ug_trx1', session: 'TRX-02', first: '01:11:40', last: '01:33:02', trend: 'steady', guidance: 'Symptom of flapping: the reconnect fired before the carrier released the previous bind.' },
];

export const EVENTS = [
  { at: '2026-08-15 01:41:12', type: 'throttle.detected', severity: 'warning', object: 'mtn_ug_trx1', detail: 'ESME_RTHROTTLED rate exceeded 4/s', correlation: 'c-8f14e45f' },
  { at: '2026-08-15 01:40:02', type: 'queue.threshold.crossed', severity: 'warning', object: 'q-mtn-trx1', detail: 'depth passed 1,000 with positive growth', correlation: 'c-8f14e45f' },
  { at: '2026-08-15 01:33:02', type: 'session.bind.failed', severity: 'warning', object: 'TRX-02', detail: 'ESME_RALYBND — previous bind not yet released', correlation: 'c-2b6b8d0c' },
  { at: '2026-08-15 01:19:58', type: 'connection.lost', severity: 'critical', object: 'utl_ug_trx', detail: 'both sessions unbound after 6 missed enquire_link responses', correlation: 'c-ea1e4d54' },
  { at: '2026-08-15 01:14:02', type: 'operator.action', severity: 'info', object: 'TRX-02', detail: 'alert ALR-4469 acknowledged by operator', correlation: 'c-2b6b8d0c' },
  { at: '2026-08-15 00:58:12', type: 'dlr.degradation', severity: 'warning', object: 'smart_ug_tx', detail: 'delivery rate fell below 95% over 15m', correlation: 'c-9c1a2b6b' },
  { at: '2026-08-15 00:58:40', type: 'route.failover.manual', severity: 'info', object: 'r-smart', detail: 'operator override to smart_ug_tx during carrier throttling', correlation: 'c-9c1a2b6b' },
  { at: '2026-08-15 00:12:31', type: 'telemetry.stale', severity: 'warning', object: 'smile-ug', detail: 'no metrics received for 5m — health reported unknown', correlation: 'c-45fea1e4' },
];

export const SERVICES = [
  { name: 'bearerbox', role: 'Kamex core transport', state: 'degraded', uptime: '6d 04:18', cpu: 38, ram: 41, rate: '408 msg/s', detail: 'one carrier bind down' },
  { name: 'smsbox-01', role: 'Submit front end', state: 'healthy', uptime: '6d 04:18', cpu: 12, ram: 22, rate: '214 req/s', detail: 'p95 82 ms' },
  { name: 'smsbox-02', role: 'Submit front end', state: 'healthy', uptime: '6d 04:17', cpu: 11, ram: 21, rate: '198 req/s', detail: 'p95 88 ms' },
  { name: 'sqlbox', role: 'DLR datastore bridge', state: 'healthy', uptime: '6d 04:16', cpu: 9, ram: 18, rate: '—', detail: 'reachable, 41 connections' },
  { name: 'postgres', role: 'Database', state: 'healthy', uptime: '18d 22:04', cpu: 22, ram: 58, rate: '—', detail: 'pool 41/100, no slow-query alarm' },
  { name: 'redis', role: 'Cache and locks', state: 'healthy', uptime: '18d 22:04', cpu: 4, ram: 12, rate: '—', detail: 'reachable' },
  { name: 'metrics-collector', role: 'Scrape and ingest', state: 'degraded', uptime: '0d 01:12', cpu: 18, ram: 26, rate: '—', detail: 'last scrape of smile_ug_tx failed — dependent health is unknown' },
];

export const NODES = [
  { name: 'kmx-gw-01', role: 'Engine + smsbox', cpu: 41, ram: 62, disk: 58, net: '184 Mbps', load: '2.14', version: 'kamex 1.8.3', state: 'healthy' },
  { name: 'kmx-gw-02', role: 'Engine + smsbox', cpu: 38, ram: 59, disk: 55, net: '171 Mbps', load: '1.98', version: 'kamex 1.8.3', state: 'healthy' },
  { name: 'kmx-db-01', role: 'PostgreSQL', cpu: 22, ram: 71, disk: 78, net: '44 Mbps', load: '1.12', version: 'pg 16.3', state: 'degraded' },
  { name: 'kmx-obs-01', role: 'Metrics and logs', cpu: 16, ram: 34, disk: 41, net: '22 Mbps', load: '0.62', version: 'prom 2.53', state: 'healthy' },
];

export const AUDIT = [
  { at: '2026-08-15 01:41:44', actor: 'operator', role: 'NOC Operator', action: 'smsc.reconnect', target: 'mtn_ug_trx1', previous: 'degraded', reason: 'Carrier throttling, cycling bind per runbook 4.2', result: 'bind_cycled', correlation: 'c-8f14e45f' },
  { at: '2026-08-15 01:20:44', actor: 'eng.nakato', role: 'Messaging Engineer', action: 'smsc.reconnect', target: 'utl_ug_trx', previous: 'disconnected', reason: 'Recovering after carrier-side drop', result: 'failed — connection refused', correlation: 'c-ea1e4d54' },
  { at: '2026-08-15 01:14:02', actor: 'operator', role: 'NOC Operator', action: 'alert.acknowledge', target: 'ALR-4469', previous: 'active', reason: 'Investigating session flapping', result: 'acknowledged', correlation: 'c-2b6b8d0c' },
  { at: '2026-08-15 00:58:40', actor: 'eng.nakato', role: 'Messaging Engineer', action: 'route.failover.manual', target: 'r-smart', previous: 'automatic', reason: 'Carrier instructed traffic movement', result: 'active target unchanged, mode set manual', correlation: 'c-9c1a2b6b' },
  { at: '2026-08-15 00:12:31', actor: 'operator', role: 'NOC Operator', action: 'smsc.suspend', target: 'smile_ug_tx', previous: 'connected', reason: 'Planned carrier maintenance window', result: 'suspended', correlation: 'c-45fea1e4' },
  { at: '2026-08-14 22:41:08', actor: 'eng.okello', role: 'Messaging Engineer', action: 'test.send', target: 'airtel_ug_trx1', previous: '—', reason: 'Verifying end-to-end delivery after rebind', result: 'delivered in 4.2s', correlation: 'c-7b4dea08' },
];

export const TRACE_MESSAGES = [
  { id: 'kmx_01HXQ4K2R9', carrierId: '448210-mtn', msisdn: '+256772000118', sender: 'SMSONE', carrier: 'MTN Uganda', smsc: 'mtn_ug_trx1', route: 'MTN national', status: 'failed', submitted: '01:41:07', final: '01:41:11', body: 'Your OTP is 448 210. It expires in 5 minutes.' },
  { id: 'kmx_01HXQ4K7B1', carrierId: '448211-air', msisdn: '+256700004512', sender: 'SMSONE', carrier: 'Airtel Uganda', smsc: 'airtel_ug_trx1', route: 'Airtel national', status: 'delivered', submitted: '01:40:44', final: '01:40:46', body: 'Payment of UGX 240,000 received. Ref INV-2026-0318.' },
  { id: 'kmx_01HXQ4M1D4', carrierId: '—', msisdn: '+256712330991', sender: 'SMSONE', carrier: 'UTL', smsc: 'utl_ug_trx', route: 'UTL national', status: 'queued', submitted: '01:20:12', final: '—', body: 'Scheduled maintenance tonight 22:00-02:00 EAT.' },
  { id: 'kmx_01HXQ4N3H8', carrierId: '448214-mtn', msisdn: '+256776553219', sender: 'SMSONE', carrier: 'MTN Uganda', smsc: 'mtn_ug_trx1', route: 'MTN national', status: 'pending', submitted: '01:39:58', final: '—', body: 'Balance: UGX 18,400. Dial *165# to top up.' },
];

export const TRACE_STAGES = {
  kmx_01HXQ4K2R9: [
    { at: '01:41:07.108', stage: 'ingress', detail: 'accepted from submit API', latency: '—', state: 'ok' },
    { at: '01:41:07.121', stage: 'route decision', detail: 'MTN national → mtn_ug_trx1 (prefix 25677)', latency: '13 ms', state: 'ok' },
    { at: '01:41:07.140', stage: 'queue', detail: 'queued behind 1,284 messages', latency: '19 ms', state: 'ok' },
    { at: '01:41:10.884', stage: 'submit_sm', detail: 'sent on session TRX-01', latency: '3.74 s', state: 'ok' },
    { at: '01:41:11.002', stage: 'submit_sm_resp', detail: 'ESME_RINVDSTADR (0x0000000B)', latency: '118 ms', state: 'error' },
    { at: '—', stage: 'deliver_sm / DLR', detail: 'no receipt — the carrier never accepted the message', latency: '—', state: 'missing' },
  ],
  kmx_01HXQ4K7B1: [
    { at: '01:40:44.201', stage: 'ingress', detail: 'accepted from submit API', latency: '—', state: 'ok' },
    { at: '01:40:44.216', stage: 'route decision', detail: 'Airtel national → airtel_ug_trx1 (prefix 25670)', latency: '15 ms', state: 'ok' },
    { at: '01:40:44.230', stage: 'queue', detail: 'queued behind 96 messages', latency: '14 ms', state: 'ok' },
    { at: '01:40:44.980', stage: 'submit_sm', detail: 'sent on session TRX-04', latency: '750 ms', state: 'ok' },
    { at: '01:40:45.104', stage: 'submit_sm_resp', detail: 'ESME_ROK, carrier message ID 448211-air', latency: '124 ms', state: 'ok' },
    { at: '01:40:46.402', stage: 'DLR', detail: 'DELIVRD, err:000', latency: '1.30 s', state: 'ok' },
  ],
};

export const DLR_FUNNEL = [
  { stage: 'Submitted', value: 1284004 },
  { stage: 'Accepted by SMSC', value: 1271882 },
  { stage: 'DLR received', value: 1240117 },
  { stage: 'Delivered', value: 1199095 },
];

export const DLR_STATUSES = [
  { status: 'DELIVRD', count: 1199095, share: 93.4, tone: 'good' },
  { status: 'UNDELIV', count: 24118, share: 1.9, tone: 'bad' },
  { status: 'EXPIRED', count: 9204, share: 0.7, tone: 'bad' },
  { status: 'REJECTD', count: 7700, share: 0.6, tone: 'bad' },
  { status: 'UNKNOWN', count: 1204, share: 0.1, tone: 'muted' },
  { status: 'pending', count: 12122, share: 0.9, tone: 'warn' },
  { status: 'no-DLR', count: 30561, share: 2.4, tone: 'warn' },
];

export const CARRIER_QUALITY = [
  { carrier: 'MTN Uganda', delivery: 96.2, p50: '2.4s', p95: '11.2s', p99: '28.4s', noDlr: 2.1, reject: 2.1, throttle: 4.1 },
  { carrier: 'Airtel Uganda', delivery: 98.8, p50: '1.8s', p95: '6.4s', p99: '14.1s', noDlr: 0.6, reject: 0.4, throttle: 0 },
  { carrier: 'Lycamobile Uganda', delivery: 97.8, p50: '2.1s', p95: '8.9s', p99: '19.8s', noDlr: 1.1, reject: 0.9, throttle: 0 },
  { carrier: 'Smart Telecom', delivery: 94.1, p50: '3.8s', p95: '14.6s', p99: '41.2s', noDlr: 3.4, reject: 3.8, throttle: 0.8 },
  { carrier: 'UTL', delivery: null, p50: '—', p95: '—', p99: '—', noDlr: null, reject: null, throttle: null },
  { carrier: 'Smile Telecom', delivery: null, p50: '—', p95: '—', p99: '—', noDlr: null, reject: null, throttle: null },
];

export const MT_SERIES = [318, 402, 388, 441, 462, 508, 486, 512, 498, 474, 441, 408];
export const MO_SERIES = [42, 51, 48, 58, 61, 66, 62, 68, 64, 59, 55, 49];
export const DLR_SERIES = [302, 388, 372, 428, 446, 492, 470, 494, 480, 458, 424, 392];
export const CLOCK_LABELS = ['01:30', '01:32', '01:34', '01:36', '01:38', '01:40'];

/* Health helpers — the four states in section 3.3, plus SMPP bind states. */
export const healthTone = (state) => {
  const s = String(state).toLowerCase();
  if (['healthy', 'connected', 'bound_trx', 'bound_tx', 'bound_rx', 'active', 'recovered', 'ok'].includes(s)) return 'good';
  if (['degraded', 'warning', 'suspended', 'acknowledged', 'throttled'].includes(s)) return 'warn';
  if (['critical', 'disconnected', 'unbound', 'closed', 'failed', 'down'].includes(s)) return 'bad';
  return 'muted';
};

export const BIND_LABELS = {
  BOUND_TRX: 'Bound (transceiver)',
  BOUND_TX: 'Bound (transmitter)',
  BOUND_RX: 'Bound (receiver)',
  OPEN: 'Open, not bound',
  UNBOUND: 'Unbound',
  CLOSED: 'Closed',
};
