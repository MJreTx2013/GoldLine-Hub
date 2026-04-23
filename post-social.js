const https = require('https');

const PAGE_ID = process.env.FB_PAGE_ID;
const PAGE_TOKEN = process.env.FB_PAGE_TOKEN;

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { resolve({ error: raw }); }
      });
    }).on('error', reject);
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
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
    const boundary = 'GoldLine' + Date.now();
    const urlObj = new URL(url);
    const parts = [];

    for (const [key, val] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    parts.push(imageBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, (res) => {
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
  if (!PAGE_ID || !PAGE_TOKEN) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing FB_PAGE_ID or FB_PAGE_TOKEN environment variables' }) };

  // Log incoming request details
  const bodyLength = event.body ? event.body.length : 0;
  console.log('Request received:', {
    bodyLength,
    isBase64Encoded: event.isBase64Encoded,
    contentType: event.headers['content-type'] || event.headers['Content-Type']
  });

  let body;
  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    body = JSON.parse(rawBody);
  } catch(e) {
    console.log('JSON parse failed:', e.message, 'body preview:', event.body ? event.body.substring(0, 200) : 'empty');
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON: ' + e.message }) };
  }

  const { message, platform, imageData, imageUrl, imageName, imageMime } = body;

  console.log('Parsed body:', {
    platform,
    messageLength: message?.length,
    hasImageData: !!imageData,
    imageDataLength: imageData?.length,
    hasImageUrl: !!imageUrl,
    imageUrl: imageUrl ? imageUrl.substring(0, 80) : null
  });

  if (!message || !message.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Message is required' }) };
  }

  const results = {};
  let fbPhotoUrl = null;

  // ── INSTAGRAM ONLY (called after Facebook photo post) ──
  if (platform === 'instagram_only') {
    if (!imageUrl) {
      return { statusCode: 200, headers, body: JSON.stringify({ instagram: { success: false, error: 'Image URL required' } }) };
    }
    try {
      const igAccountRes = await getJSON(`https://graph.facebook.com/v25.0/${PAGE_ID}?fields=instagram_business_account&access_token=${PAGE_TOKEN}`);
      const igId = igAccountRes?.instagram_business_account?.id;
      console.log('Instagram account ID:', igId);
      if (!igId) {
        return { statusCode: 200, headers, body: JSON.stringify({ instagram: { success: false, error: 'Instagram Business Account not connected' } }) };
      }
      const containerRes = await postJSON(
        `https://graph.facebook.com/v25.0/${igId}/media`,
        { image_url: imageUrl, caption: message.trim(), access_token: PAGE_TOKEN }
      );
      console.log('Instagram container:', containerRes);
      if (!containerRes.id) {
        return { statusCode: 200, headers, body: JSON.stringify({ instagram: { success: false, error: containerRes.error?.message || 'Container failed' } }) };
      }
      const publishRes = await postJSON(
        `https://graph.facebook.com/v25.0/${igId}/media_publish`,
        { creation_id: containerRes.id, access_token: PAGE_TOKEN }
      );
      console.log('Instagram publish:', publishRes);
      return { statusCode: 200, headers, body: JSON.stringify({
        instagram: publishRes.id ? { success: true, id: publishRes.id } : { success: false, error: publishRes.error?.message || 'Publish failed' }
      })};
    } catch(e) {
      console.log('Instagram error:', e.message);
      return { statusCode: 200, headers, body: JSON.stringify({ instagram: { success: false, error: e.message } }) };
    }
  }

  // ── FACEBOOK ──
  if (platform === 'facebook' || platform === 'both') {
    try {
      if (imageData) {
        console.log('Uploading photo via base64, size:', imageData.length);
        const imageBuffer = Buffer.from(imageData, 'base64');
        console.log('Buffer size:', imageBuffer.length);

        const fbRes = await postMultipart(
          `https://graph.facebook.com/v25.0/${PAGE_ID}/photos`,
          { caption: message.trim(), access_token: PAGE_TOKEN },
          imageBuffer,
          imageName || 'photo.jpg',
          imageMime || 'image/jpeg'
        );
        console.log('Facebook photo upload result:', fbRes);

        if (fbRes.id) {
          results.facebook = { success: true, id: fbRes.id };
          try {
            const photoData = await getJSON(`https://graph.facebook.com/v25.0/${fbRes.id}?fields=images&access_token=${PAGE_TOKEN}`);
            if (photoData.images && photoData.images.length > 0) {
              fbPhotoUrl = photoData.images[0].source;
              console.log('Got FB photo URL for Instagram:', fbPhotoUrl ? 'yes' : 'no');
            }
          } catch(e) { console.log('Could not get photo URL:', e.message); }
        } else {
          results.facebook = { success: false, error: fbRes.error?.message || 'Photo upload failed' };
          console.log('Photo upload failed:', fbRes);
        }

      } else if (imageUrl) {
        console.log('Posting photo via URL:', imageUrl.substring(0, 80));
        const fbRes = await postJSON(
          `https://graph.facebook.com/v25.0/${PAGE_ID}/photos`,
          { caption: message.trim(), url: imageUrl, access_token: PAGE_TOKEN }
        );
        console.log('Facebook URL photo result:', fbRes);

        if (fbRes.id) {
          results.facebook = { success: true, id: fbRes.id };
          fbPhotoUrl = imageUrl;
        } else {
          results.facebook = { success: false, error: fbRes.error?.message || 'Photo URL post failed' };
        }

      } else {
        console.log('Text-only post');
        const fbRes = await postJSON(
          `https://graph.facebook.com/v25.0/${PAGE_ID}/feed`,
          { message: message.trim(), access_token: PAGE_TOKEN }
        );
        console.log('Facebook text post result:', fbRes);

        if (fbRes.id) {
          results.facebook = { success: true, id: fbRes.id };
        } else {
          results.facebook = { success: false, error: fbRes.error?.message || 'Post failed' };
        }
      }
    } catch(e) {
      console.log('Facebook error:', e.message);
      results.facebook = { success: false, error: e.message };
    }
  }

  // ── INSTAGRAM (via Facebook photo URL) ──
  if (platform === 'both') {
    const igImageUrl = fbPhotoUrl || imageUrl;
    if (!igImageUrl) {
      results.instagram = { success: false, error: 'Instagram requires an image. Facebook post was published.' };
    } else {
      try {
        const igAccountRes = await getJSON(`https://graph.facebook.com/v25.0/${PAGE_ID}?fields=instagram_business_account&access_token=${PAGE_TOKEN}`);
        const igId = igAccountRes?.instagram_business_account?.id;
        if (!igId) {
          results.instagram = { success: false, error: 'Instagram Business Account not connected' };
        } else {
          const containerRes = await postJSON(
            `https://graph.facebook.com/v25.0/${igId}/media`,
            { image_url: igImageUrl, caption: message.trim(), access_token: PAGE_TOKEN }
          );
          if (!containerRes.id) {
            results.instagram = { success: false, error: containerRes.error?.message || 'Instagram container failed' };
          } else {
            const publishRes = await postJSON(
              `https://graph.facebook.com/v25.0/${igId}/media_publish`,
              { creation_id: containerRes.id, access_token: PAGE_TOKEN }
            );
            results.instagram = publishRes.id
              ? { success: true, id: publishRes.id }
              : { success: false, error: publishRes.error?.message || 'Instagram publish failed' };
          }
        }
      } catch(e) {
        results.instagram = { success: false, error: e.message };
      }
    }
  }

  console.log('Final results:', results);
  return { statusCode: 200, headers, body: JSON.stringify(results) };
};
