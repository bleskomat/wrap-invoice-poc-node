let config = {
	fee: {
		percent: parseFloat(process.env.FEE_PERCENT || '0'),
		fixed: parseInt(process.env.FEE_FIXED),// msat
	},
	lnd: {
		hostname: process.env.LND_HOSTNAME || null,
		tls_cert: process.env.LND_TLS_CERT || null,
		macaroon: process.env.LND_MACAROON || null,
	},
};

module.exports = config;
