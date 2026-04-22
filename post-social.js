const https = require('https');

const PAGE_ID = process.env.FB_PAGE_ID;
const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { resolve({ error: raw }); }
      });
    });
    req.on('error', reject);
  });
}

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

function postMultipart(url, fields, imageBuffer, filename, mimeType) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Math.random().toString(36).substr(2);
    const urlObj = new URL(url);
    let bodyParts = [];

    for (const [key, value] of Object.entries(fields)) {
      bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
    }

    bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    bodyParts.push(imageBuffer);
    bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(bodyParts);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
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
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!PAGE_ID || !PAGE_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error — contact MJ' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { message, platform, imageData, imageUrl, imageName, imageMime } = body;

  if (!message || !message.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Message is required' }) };
  }

  const results = {};
  let fbPhotoUrl = null;

  // ── FACEBOOK ──
  if (platform === 'facebook' || platform === 'both') {
    try {
      if (imageData) {
        // Upload photo from base64
        const imageBuffer = Buffer.from(imageData, 'base64');
        const fname = imageName || 'photo.jpg';
        const fmime = imageMime || 'image/jpeg';
        const fbRes = await postMultipart(
          `https://graph.facebook.com/v25.0/${PAGE_ID}/photos`,
          { caption: message.trim(), access_token: PAGE_TOKEN },
          imageBuffer, fname, fmime
        );
        if (fbRes.id) {
          results.facebook = { success: true, id: fbRes.id };
          // Try to get public photo URL for Instagram
          try {
            const photoData = await getJSON(`https://graph.facebook.com/v25.0/${fbRes.id}?fields=images&access_token=${PAGE_TOKEN}`);
            if (photoData.images && photoData.images.length > 0) {
              fbPhotoUrl = photoData.images[0].source;
            }
          } catch(e) {}
        } else {
          results.facebook = { success: false, error: fbRes.error?.message || 'Photo upload failed' };
        }

      } else if (imageUrl) {
        // Post photo from URL
        const fbRes = await postJSON(
          `https://graph.facebook.com/v25.0/${PAGE_ID}/photos`,
          { caption: message.trim(), url: imageUrl, access_token: PAGE_TOKEN }
        );
        if (fbRes.id) {
          results.facebook = { success: true, id: fbRes.id };
          fbPhotoUrl = imageUrl;
        } else {
          results.facebook = { success: false, error: fbRes.error?.message || 'Photo post failed' };
        }

      } else {
        // Text only
        const fbRes = await postJSON(
          `https://graph.facebook.com/v25.0/${PAGE_ID}/feed`,
          { message: message.trim(), access_token: PAGE_TOKEN }
        );
        if (fbRes.id) {
          results.facebook = { success: true, id: fbRes.id };
        } else {
          results.facebook = { success: false, error: fbRes.error?.message || 'Post failed' };
        }
      }
    } catch(e) {
      results.facebook = { success: false, error: e.message };
    }
  }

  // ── INSTAGRAM ──
  if (platform === 'both') {
    const igImageUrl = fbPhotoUrl || imageUrl;
    if (!igImageUrl) {
      results.instagram = { success: false, error: 'Instagram requires an image. Your Facebook post was published.' };
    } else {
      try {
        const igAccountRes = await getJSON(`https://graph.facebook.com/v25.0/${PAGE_ID}?fields=instagram_business_account&access_token=${PAGE_TOKEN}`);
        const igId = igAccountRes?.instagram_business_account?.id;

        if (!igId) {
          results.instagram = { success: false, error: 'Instagram Business Account not connected — check Meta Business Suite' };
        } else {
          const containerRes = await postJSON(
            `https://graph.facebook.com/v25.0/${igId}/media`,
            { image_url: igImageUrl, caption: message.trim(), access_token: PAGE_TOKEN }
          );
          if (!containerRes.id) {
            results.instagram = { success: false, error: containerRes.error?.message || 'Instagram container creation failed' };
          } else {
            const publishRes = await postJSON(
              `https://graph.facebook.com/v25.0/${igId}/media_publish`,
              { creation_id: containerRes.id, access_token: PAGE_TOKEN }
            );
            if (publishRes.id) {
              results.instagram = { success: true, id: publishRes.id };
            } else {
              results.instagram = { success: false, error: publishRes.error?.message || 'Instagram publish failed' };
            }
          }
        }
      } catch(e) {
        results.instagram = { success: false, error: e.message };
      }
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify(results) };
};
