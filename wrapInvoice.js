const assert = require('assert');
const http = require('http');
const https = require('https');
const querystring = require('querystring');
const tls = require('tls');
const url = require('url');
const WebSocket = require('ws');

// https://lightning.bot/configuration/testnet/

// https://github.com/motdotla/dotenv#usage
require('dotenv').config();

const config = require('./config');

assert.ok(config.lnd.hostname, 'Missing required config: "lnd.hostname"');
assert.ok(config.lnd.tls_cert, 'Missing required config: "lnd.tls_cert"');
assert.ok(config.lnd.macaroon, 'Missing required config: "lnd.macaroon"');
assert.ok(!Number.isNaN(parseFloat(config.fee.percent)), 'Invalid config ("fee.percent"): Number expected');
assert.ok(!Number.isNaN(parseInt(config.fee.fixed)), 'Invalid config ("fee.fixed"): Integer expected');
assert.ok(config.fee.fixed >= 1000, 'Invalid config ("fee.fixed"): Minimum value is 1000 msat');

const tlsCert = config.lnd.tls_cert.replace(/\\n/g, '\n');

const base64ToBase64Url = str => {
	// !! IMPORTANT !!
	//  - LND use a slightly non-standard implementation of base64url.
	//  - Replace "+" with "-" and "/" with "_" but leave padding ("=" characters at end).
	return str.replace(/\+/g, '-').replace(/\//g, '_');
};

const hexToBase64Url = str => {
	return base64ToBase64Url(Buffer.from(str, 'hex').toString('base64'));
};

const lndRestApi = (method, uri, data, options) => {
	return Promise.resolve().then(() => {
		console.log('lndRestApi', { method, uri, data });
		options = Object.assign({}, {
			abortTimeout: null,
		}, options || {});
		const requestUrl = `https://${config.lnd.hostname}${uri}`;
		const parsedUrl = url.parse(requestUrl);
		let requestOptions = {
			method: method.toUpperCase(),
			hostname: parsedUrl.hostname,
			port: parsedUrl.port,
			path: parsedUrl.path,
			headers: { 'Grpc-Metadata-Macaroon': config.lnd.macaroon },
			ca: tlsCert,
		};
		if (data) {
			if (requestOptions.method === 'POST' || requestOptions.method === 'PUT') {
				data = JSON.stringify(data);
				requestOptions.headers['Content-Type'] = 'application/json';
				requestOptions.headers['Content-Length'] = Buffer.byteLength(data);
			} else {
				requestOptions.path += '?' + querystring.stringify(data);
			}
		}
		const request = parsedUrl.protocol === 'https:' ? https.request : http.request;
		return new Promise((resolve, reject) => {
			try {
				const req = request(requestOptions, res => {
					let body = '';
					res.on('data', buffer => body += buffer.toString());
					res.on('end', () => {
						let json;
						if (res.headers['content-type'].substr(0, 'application/json'.length) === 'application/json') {
							try { json = JSON.parse(body); } catch (error) {
								return reject(error);
							}
						} else {
							return reject(new Error('Unexpected Response Content-Type: ' + res.headers['content-type']));
						}
						if (json.error) {
							return reject(new Error(json.error));
						}
						if (json.code > 0) {
							return reject(new Error(json.message));
						}
						resolve(json || null);
					});
				});
				if (data && (requestOptions.method === 'POST' || requestOptions.method === 'PUT')) {
					req.write(data);
				}
				req.once('error', reject);
				req.end();
				if (options.abortTimeout) {
					setTimeout(() => {
						req.abort();
					}, options.abortTimeout);
				}
			} catch (error) {
				return reject(error);
			}
		});
	});
};

const decodePayReq = payreq => {
	return lndRestApi('get', `/v1/payreq/${payreq}`);
};

const lookupInvoice = paymentHash => {
	return lndRestApi('get', '/v2/invoices/lookup', {
		payment_hash: hexToBase64Url(paymentHash),
	});
};

const createWrappedInvoice = params => {
	let wrapped;
	return lndRestApi('post', '/v2/invoices/hodl', params, {
		abortTimeout: 2000,// This end-point of LND hangs.
	}).catch(error => {
		// Either fails because of aborting the HTTP request.
		// Or fails because the hold invoice already exists.
		// In either case, next we will check for the existence of the hold invoice.
	}).finally(() => {
		return lookupInvoice(Buffer.from(params.hash, 'base64').toString('hex')).then(result => {
			wrapped = result;
		});
	}).then(() => {
		assert.ok(wrapped);
		return wrapped;
	});
};

const waitUntilInvoiceStateAccepted = paymentHash => {
	return new Promise((resolve, reject) => {
		try {
			const hash = hexToBase64Url(paymentHash);
			let ws = new WebSocket(`wss://${config.lnd.hostname}/v2/invoices/subscribe/${hash}`, {
				headers: { 'Grpc-Metadata-Macaroon': config.lnd.macaroon },
				ca: tlsCert,
			});
			const done = error => {
				if (ws && ws.readyState === 'OPEN') {
					ws.terminate();
					ws = null;
				}
				if (error) return reject(error);
				resolve();
			};
			ws.on('error', done);
			ws.on('message', message => {
				let json;
				try { json = JSON.parse(message.toString()); } catch (error) {
					return done(new Error('Invalid message received via WebSocket: JSON data expected'));
				}
				try {
					assert.ok(json && typeof json === 'object');
					assert.notStrictEqual(json.result.state, 'CANCELED', 'Wrapped invoice was canceled');
					assert.notStrictEqual(json.result.state, 'SETTLED', 'Wrapped invoice was settled - should have been accepted first');
				} catch (error) {
					return done(error);
				}
				if (json.result.state === 'ACCEPTED') {
					return done();
				}
			});
		} catch (error) {
			return reject(error);
		}
	});
};

const payInvoice = (payreq, feeLimit) => {
	return lndRestApi('post', '/v1/channels/transactions', {
		payment_request: payreq,
		fee_limit: feeLimit,
	}).then(result => {
		assert.ok(!result.payment_error, `Failed to pay invoice: ${result.payment_error}`);
		const preimage = result && result.payment_preimage || null;
		assert.ok(preimage, 'Missing preimage');
		return preimage;
	});
};

const cancelInvoice = paymentHash => {
	return lndRestApi('post', '/v2/invoices/cancel', {
		payment_hash: hexToBase64Url(paymentHash),
	});
};

const settleInvoice = preimage => {
	return lndRestApi('post', '/v2/invoices/settle', { preimage });
};

// Step 1 = Decode invoice
// Step 2 = Create wrapped ("hold") invoice:
//          - Same payment hash
//          - Same expire time
//          - Same memo/description/description_hash
//          - Amount should equal original amount + fees for wrapper service
// Step 3 = Wait until wrapped invoice is paid and funds locked
// Step 4 = Pay original invoice to obtain preimage
// Step 5 = Settle the wrapped ("hold") invoice by providing the preimage

const originalInvoice = process.argv[2] || null;
assert.ok(originalInvoice, 'Must provide an invoice');

decodePayReq(originalInvoice).then(decoded => {
	console.log('Original invoice decoded:', decoded);
	const originalAmount = parseInt(decoded.num_msat);// msat
	assert.ok(!Number.isNaN(originalAmount));
	const newAmount = Math.ceil(originalAmount + (originalAmount * (config.fee.percent / 100)) + config.fee.fixed);// msat
	assert.ok(!Number.isNaN(newAmount));
	const newExpiry = (parseInt(decoded.timestamp) + parseInt(decoded.expiry)) - Math.floor(Date.now() / 1000);
	assert.ok(!Number.isNaN(newExpiry));
	return createWrappedInvoice({
		memo: !decoded.description_hash ? decoded.description : '',
		hash: Buffer.from(decoded.payment_hash, 'hex').toString('base64'),
		value_msat: newAmount.toString(),// msat
		description_hash: decoded.description_hash ? decoded.description_hash : '',
		expiry: newExpiry.toString(),
	}).then(wrapped => {
		assert.ok(wrapped);
		if (wrapped.state === 'OPEN') {
			console.log('Pay the wrapped invoice:', wrapped.payment_request);
			return waitUntilInvoiceStateAccepted(decoded.payment_hash);
		}
		assert.notStrictEqual(wrapped.state, 'CANCELED', 'Wrapped invoice was canceled');
		assert.notStrictEqual(wrapped.state, 'SETTLED', 'Wrapped invoice is already settled');
		assert.strictEqual(wrapped.state, 'ACCEPTED');
	}).then(() => {
		console.log('Wrapped invoice state = ACCEPTED');
		console.log('Paying original invoice to obtain preimage...');
		return payInvoice(originalInvoice, {
			fixed_msat: config.fee.fixed.toString(),
		}).catch(error => {
			console.log('Canceling wrapped invoice...');
			return cancelInvoice(decoded.payment_hash).then(() => {
				throw new Error('Failed to pay original invoice: ' + error.message);
			});
		}).then(preimage => {
			console.log('Original invoice paid, preimage =', preimage);
			console.log('Settling wrapped invoice...');
			return settleInvoice(preimage);
		});
	});
}).then(() => {
	console.log('Done!');
	process.exit();
}).catch(error => {
	console.error(error);
	process.exit(1);
});
