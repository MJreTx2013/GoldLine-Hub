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
    const boundary = '----GoldLineBoundary' + Date.now().toString(36);
    const urlObj = new URL(url);
    let parts = [];

    for (const [key, value] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
    }

    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    parts.push(imageBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
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

// Parse multipart form data from Netlify event
function parseMultipart(event) {
  const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) return null;

  const boundary = boundaryMatch[1];
  const bodyBuffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  const boundaryBuf = Buffer.from(`--${boundary}`);

  const result = { fields: {}, file: null };
  const parts = [];

  let start = 0;
  let pos = 0;

  while (pos < bodyBuffer.length) {
    const idx = bodyBuffer.indexOf(boundaryBuf, pos);
    if (idx === -1) break;
    if (start > 0) {
      parts.push(bodyBuffer.slice(start, idx - 2)); // -2 for \r\n before boundary
    }
    pos = idx + boundaryBuf.length + 2; // skip boundary + \r\n
    start = pos;
  }

  for (const part of parts) {
    if (part.length === 0) continue;

    // Find end of headers
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headerStr = part.slice(0, headerEnd).toString('utf8');
    const content = part.slice(headerEnd + 4);

    // Remove trailing \r\n if present
    const trimmedContent = content[content.length - 2] === 13 && content[content.length - 1] === 10
      ? content.slice(0, -2)
      : content;

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const contentTypeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/);

    if (!nameMatch) continue;
    const name = nameMatch[1];

    if (filenameMatch) {
      result.file = {
        filename: filenameMatch[1],
        mimeType: contentTypeMatch ? contentTypeMatch[1].trim() : 'image/jpeg',
        data: trimmedContent
      };
    } else {
      result.fields[name] = trimmedContent.toString('utf8');
    }
  }

  return result;
}

async function postToInstagram(pageId, pageToken, imageUrl, caption) {
  const igAccountRes = await getJSON(`https://graph.facebook.com/v25.0/${pageId}?fields=instagram_business_account&access_token=${pageToken}`);
  const igId = igAccountRes?.instagram_business_account?.id;

  if (!igId) {
    return { success: false, error: 'Instagram Business Account not connected — check Meta Business Suite' };
  }

  const containerRes = await postJSON(
    `https://graph.facebook.com/v25.0/${igId}/media`,
    { image_url: imageUrl, caption: caption, access_token: pageToken }
  );

  if (!containerRes.id) {
    return { success: false, error: containerRes.error?.message || 'Instagram container creation failed' };
  }

  const publishRes = await postJSON(
    `https://graph.facebook.com/v25.0/${igId}/media_publish`,
    { creation_id: containerRes.id, access_token: pageToken }
  );

  if (publishRes.id) {
    return { success: true, id: publishRes.id };
  }
  return { success: false, error: publishRes.error?.message || 'Instagram publish failed' };
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

  const contentType = (event.headers['content-type'] || event.headers['Content-Type'] || '');
  const isMultipart = contentType.includes('multipart/form-data');

  let message, platform, imageUrl, imageBuffer, imageName, imageMime;

  if (isMultipart) {
    // Parse FormData (file upload)
    const parsed = parseMultipart(event);
    if (!parsed) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Could not parse form data' }) };

    message = parsed.fields.message;
    platform = parsed.fields.platform || 'facebook';

    if (parsed.file) {
      imageBuffer = parsed.file.data;
      imageName = parsed.file.filename;
      imageMime = parsed.file.mimeType;
    }
  } else {
    // Parse JSON
    try {
      const body = JSON.parse(event.body);
      message = body.message;
      platform = body.platform || 'facebook';
      imageUrl = body.imageUrl;
    } catch(e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
    }
  }

  if (!message || !message.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Message is required' }) };
  }

  const results = {};
  let fbPhotoUrl = null;

  // ── FACEBOOK ──
  if (platform === 'facebook' || platform === 'both') {
    try {
      if (imageBuffer) {
        // Upload photo file
        const fbRes = await postMultipart(
          `https://graph.facebook.com/v25.0/${PAGE_ID}/photos`,
          { caption: message.trim(), access_token: PAGE_TOKEN },
          imageBuffer,
          imageName || 'photo.jpg',
          imageMime || 'image/jpeg'
        );

        if (fbRes.id) {
          results.facebook = { success: true, id: fbRes.id };
          // Get public URL for Instagram
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
      results.instagram = { success: false, error: 'Instagram requires an image. Your Facebook post was published successfully.' };
    } else {
      try {
        results.instagram = await postToInstagram(PAGE_ID, PAGE_TOKEN, igImageUrl, message.trim());
      } catch(e) {
        results.instagram = { success: false, error: e.message };
      }
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify(results) };
};
