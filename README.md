# Wrapped Invoices Proof-of-Concept

## Building blocks

### Parties

- Operator
- Service provider
- Customer

### BOLT #11: Invoice Protocol for Lightning Payments

- Human-Readable Part

  1. `prefix`
  1. `amount`

- Data Part

  1.  'timestamp'
  1.  zero or more tagged parts
  1.  'signature'

  - Tagged parts
    - Payment hash - Preimage of this provides proof of payment.

lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh

payment hash: qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq
payment preimage: 0001020304050607080900010203040506070809000102030405060708090102

### Wrapping Bolt11 invoices

Payment hash of one invoice can be used in a new invoice and by doing that the second invoice is wrapping the first one because second invoice cannot cannot be considered paid until the first one is paid.

### Hodl invoices

In order to wrap and invoice the service provider holds the HTLC - It dos not release the preimage basically because it does not have it. Util it pays the wrapped invoice.

### LNURL withdraw

- withdrawRequest - Instead of asking for Lightning invoice a service could display a "withdraw" QR code which contains a specialized LNURL.

## Step by step

The purpose of this proof-of-concept is to demonstrate how to create a trustless Lightning Network payment proxy which allows a service provider to charge fees without ever taking custody over the funds being transferred. This is possible by creating a "wrapped" invoice with the same payment hash as the original invoice. Step by step:

- Customer creates bolt11 invoice with a randomly generated preimage
- Customer sends this invoice to the Service Provider to be paid
- Service Provider decodes the invoice to get the payment hash
- Service Provider creates a wrapped invoice with the _same payment hash_ and a higher amount of satoshis (the fee)
- Service Provider sends the wrapped invoice to the Operator to be paid
- Operator pays the invoice, but Service Provider doesn't have the preimage so cannot settle it yet
- Service Provider pays the original invoice from the Customer
- Service Provider receives the preimage
- Service Provider releases the preimage and the wrapped invoice can be settled
- Customer was paid what they expected, Service Provider earns a fee, the Operator paid the full amount plus fee

![](/docs/wrapped-invoice-poc-diagram.png)

## Software Requirements

- Lightning Network Daemon (LND) node is required to create hold ("hodl") invoices.
- Node.js + npm

## Setup

Install dependencies:

```bash
npm ci
```

Create `.env` file locally:

```bash
cp example.env .env
```

Set the required LND configurations:

- `LND_HOSTNAME` - Host + port to the REST API of your LND node - e.g. "127.0.0.1:8080"
- `LND_TLS_CERT` - TLS certificate of the LND node. Should be on a single line so be sure to escape new-line characters - e.g. `\\n`
- `LND_MACAROON` - Hex-encoded macaroon with permissions to get/add/settle hold invoices and to pay invoices.

## Usage

```bash
npm run wrapInvoice -- "XXX"
```

Replace `XXX` with the customer's invoice. Here's what happens:

- A new hold invoice will be added in the configured LND node.
  - **Amount** of the hold invoice = Amount of customer invoice + wrapping script's service fee
  - **Payment hash** = payment hash of the customer invoice
  - **Expiry** = same as the customer invoice
  - **Memo / description hash** = same as the customer invoice
- The wrapping script will open a websocket connection to the LND node to listen for state changes on the hold invoice.
- When the hold invoice is paid its state is changed to "ACCEPTED".
- The wrapping script will then pay the customer's invoice to obtain the preimage.
- The preimage is then used to settle the hold invoice.

## Important Notes

If a hold invoice is ACCEPTED, then it is important to either SETTLE it or CANCEL it. Do not leave it ACCEPTED. Otherwise, the last hop in the route of the hold invoice payment will be forced to force-close its channel to your LND node. The wrapping script here will automatically cancel the hold invoice if it fails to pay the customer invoice. But there could be cases where that doesn't happen as expected. So be sure to manually cancel any ACCEPTED hold invoice if it wasn't already canceled.

## License

This software is [MIT licensed](https://tldrlegal.com/license/mit-license):

> A short, permissive software license. Basically, you can do whatever you want as long as you include the original copyright and license notice in any copy of the software/source. There are many variations of this license in use.
