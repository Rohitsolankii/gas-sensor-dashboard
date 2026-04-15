const express = require('express');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 3000;
const AWS_REGION = process.env.AWS_REGION || 'ap-south-1';
const TABLE_NAME = process.env.DYNAMO_TABLE || 'gas_data';

const ddbClient = new DynamoDBClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const docClient = DynamoDBDocumentClient.from(ddbClient);

const app = express();
const server = http.createServer(app);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ================= API =================

// Health check (keeps Render.com awake)
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// List unique devices
app.get('/api/devices', async (req, res) => {
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      ProjectionExpression: 'device_id'
    }));

    const devices = [...new Set((result.Items || []).map(i => i.device_id))];
    res.json({ devices });
  } catch (err) {
    console.error('GET /api/devices error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Query data for a specific device (latest N readings, with pagination)
app.get('/api/data/:deviceId', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const params = {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'device_id = :d',
      ExpressionAttributeValues: { ':d': req.params.deviceId },
      ScanIndexForward: false,
      Limit: limit
    };

    // Pagination: if client sends lastKey, use it to fetch the next page
    if (req.query.lastKey) {
      try {
        params.ExclusiveStartKey = JSON.parse(decodeURIComponent(req.query.lastKey));
      } catch (e) {
        console.warn('Invalid lastKey:', e.message);
      }
    }

    const result = await docClient.send(new QueryCommand(params));

    // Return items in chronological order (oldest first)
    const items = (result.Items || []).reverse();

    const response = { items, count: items.length };

    // If DynamoDB has more pages, include the key for the next page
    if (result.LastEvaluatedKey) {
      response.lastKey = encodeURIComponent(JSON.stringify(result.LastEvaluatedKey));
    }

    res.json(response);
  } catch (err) {
    console.error(`GET /api/data/${req.params.deviceId} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get latest reading across all devices
app.get('/api/latest', async (req, res) => {
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      Limit: 20
    }));

    res.json({ items: result.Items || [] });
  } catch (err) {
    console.error('GET /api/latest error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= WEBSOCKET =================

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  ws.send(JSON.stringify({ type: 'connected', message: 'Live feed active' }));

  ws.on('close', () => console.log('WebSocket client disconnected'));
});

// Poll DynamoDB every 10s and push ONLY new data to WebSocket clients
// Initialize to current time so we never broadcast old/historical data
let lastPollTimestamp = new Date().toISOString();

async function pollAndBroadcast() {
  if (wss.clients.size === 0) return; // skip if no clients

  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      Limit: 100
    }));

    const allItems = result.Items || [];

    // CRITICAL FIX: Only broadcast items that are genuinely NEWER than
    // what we've already seen. DynamoDB Scan returns items in arbitrary
    // order, so we must filter out old data.
    const newItems = allItems.filter(item => {
      const ts = String(item.timestamp || '');
      return ts > lastPollTimestamp;
    });

    if (newItems.length === 0) return;

    // Update lastPollTimestamp to the newest item we've seen
    newItems.forEach(item => {
      const ts = String(item.timestamp || '');
      if (ts > lastPollTimestamp) lastPollTimestamp = ts;
    });

    // Only send the new items — not the entire scan result
    const message = JSON.stringify({ type: 'data', items: newItems });

    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(message);
    });

    console.log(`📡 Broadcast ${newItems.length} new item(s)`);
  } catch (err) {
    console.error('Poll error:', err.message);
  }
}

setInterval(pollAndBroadcast, 10000);

// ================= SELF-PING (Render.com keep-alive) =================

const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => {
    fetch(`${RENDER_URL}/health`).catch(() => {});
  }, 600000); // every 10 minutes
}

// ================= START =================

server.listen(PORT, () => {
  console.log(`🚀 Dashboard server running on port ${PORT}`);
  console.log(`📊 DynamoDB table: ${TABLE_NAME}`);
  console.log(`🌍 Region: ${AWS_REGION}`);
});