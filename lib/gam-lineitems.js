'use strict';

/**
 * Fetches line item metadata from GAM's LineItemService via SOAP.
 * Currently used only to retrieve start dates, which the dashboard shows
 * as the campaign launch date alongside impression counts.
 */

const axios = require('axios');
const xml2js = require('xml2js');
const { GAM_SOAP_NS, GAM_LINEITEM_SOAP_ENDPOINT } = require('../config');

/**
 * Fetches start dates for a list of line item IDs and returns a map of
 * lineItemId → UTC millisecond timestamp.
 * Queried in batches of 400 with internal GAM pagination (500 rows per page).
 * GAM's startDateTime uses a structured date/time object rather than ISO strings,
 * so the fields are assembled manually into Date.UTC.
 */
async function fetchLineItemStartDates(lineItemIds, networkCode, token) {
  // Returns { lineItemId → startDate as UTC ms timestamp }
  if (!lineItemIds.length) return {};
  const startDateByLI = {};
  const batchSize = 400;

  for (let i = 0; i < lineItemIds.length; i += batchSize) {
    const batch = lineItemIds.slice(i, i + batchSize);
    let offset = 0, total = null;

    while (total === null || offset < total) {
      const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header>
    <RequestHeader xmlns="${GAM_SOAP_NS}">
      <networkCode>${networkCode}</networkCode>
      <applicationName>Infinity-Dashboard</applicationName>
    </RequestHeader>
  </soapenv:Header>
  <soapenv:Body>
    <getLineItemsByStatement xmlns="${GAM_SOAP_NS}">
      <filterStatement>
        <query>WHERE id IN (${batch.join(', ')}) LIMIT 500 OFFSET ${offset}</query>
      </filterStatement>
    </getLineItemsByStatement>
  </soapenv:Body>
</soapenv:Envelope>`;

      const res = await axios.post(GAM_LINEITEM_SOAP_ENDPOINT, soap, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'SOAPAction': '', 'Authorization': `Bearer ${token}` },
        timeout: 30000,
      });
      const parsed = await xml2js.parseStringPromise(res.data);
      const rval = parsed['soap:Envelope']?.['soap:Body']?.[0]?.['getLineItemsByStatementResponse']?.[0]?.rval?.[0];
      if (!rval) break;
      total = parseInt(rval.totalResultSetSize?.[0] || '0');
      const results = rval.results || [];

      for (const li of results) {
        const id = li.id?.[0];
        const dt = li.startDateTime?.[0];
        if (id && dt) {
          const d = dt.date?.[0];
          if (d) {
            // GAM month is 1-based; Date.UTC expects 0-based
            const ts = Date.UTC(
              parseInt(d.year?.[0]    || '0'),
              parseInt(d.month?.[0]   || '1') - 1,
              parseInt(d.day?.[0]     || '1'),
              parseInt(dt.hour?.[0]   || '0'),
              parseInt(dt.minute?.[0] || '0'),
              parseInt(dt.second?.[0] || '0'),
            );
            startDateByLI[id] = ts;
          }
        }
      }

      offset += 500;
      if (results.length === 0) break;
    }
  }

  return startDateByLI;
}

module.exports = { fetchLineItemStartDates };
