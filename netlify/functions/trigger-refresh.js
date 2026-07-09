'use strict';

exports.handler = async () => {
  if (!process.env.GITHUB_PAT) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GITHUB_PAT not configured' }) };
  }
  try {
    const res = await fetch(
      'https://api.github.com/repos/im-ad-products/Dashboard-Infinity/actions/workflows/daily-refresh.yml/dispatches',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_PAT}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );
    if (res.ok || res.status === 204) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
    }
    const text = await res.text().catch(() => '');
    return { statusCode: 500, body: JSON.stringify({ error: `GitHub dispatch failed: ${res.status} ${text}` }) };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
