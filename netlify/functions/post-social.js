const https = require('https');

// Page credentials stored as Netlify environment variables
const PAGE_ID = process.env.FB_PAGE_ID;
const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { resolve({ error: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET'
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { resolve({ error: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

exports.handler = async (event) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { message, platform } = body;

  if (!message || !message.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Message is required' }) };
  }

  if (!PAGE_ID || !PAGE_TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error — contact MJ' }) };
  }

  const results = {};

  // ── POST TO FACEBOOK PAGE ──
  if (platform === 'facebook' || platform === 'both') {
    try {
      const fbResult = await postJSON(
        `https://graph.facebook.com/v25.0/${PAGE_ID}/feed`,
        { message: message.trim(), access_token: PAGE_TOKEN }
      );
      if (fbResult.id) {
        results.facebook = { success: true, id: fbResult.id };
      } else {
        results.facebook = { success: false, error: fbResult.error?.message || 'Unknown error' };
      }
    } catch(e) {
      results.facebook = { success: false, error: e.message };
    }
  }

  // ── POST TO INSTAGRAM ──
  if (platform === 'instagram' || platform === 'both') {
    try {
      // Step 1: Get Instagram Business Account ID from the page
      const igAccountRes = await getJSON(
        `https://graph.facebook.com/v25.0/${PAGE_ID}?fields=instagram_business_account&access_token=${PAGE_TOKEN}`
      );

      const igId = igAccountRes?.instagram_business_account?.id;

      if (!igId) {
        results.instagram = { success: false, error: 'Instagram Business Account not found — check page connection in Meta Business Suite' };
      } else {
        // Step 2: Create media container
        const containerRes = await postJSON(
          `https://graph.facebook.com/v25.0/${igId}/media`,
          { caption: message.trim(), media_type: 'REELS', access_token: PAGE_TOKEN }
        );

        // Try as a simple text/caption post if REELS fails
        if (!containerRes.id) {
          // Instagram requires an image or video — post as Facebook only
          results.instagram = { 
            success: false, 
            error: 'Instagram requires an image or video. Text-only posts are not supported on Instagram. Your Facebook post was published.' 
          };
        } else {
          // Step 3: Publish the container
          const publishRes = await postJSON(
            `https://graph.facebook.com/v25.0/${igId}/media_publish`,
            { creation_id: containerRes.id, access_token: PAGE_TOKEN }
          );
          if (publishRes.id) {
            results.instagram = { success: true, id: publishRes.id };
          } else {
            results.instagram = { success: false, error: publishRes.error?.message || 'Publish failed' };
          }
        }
      }
    } catch(e) {
      results.instagram = { success: false, error: e.message };
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(results)
  };
};
