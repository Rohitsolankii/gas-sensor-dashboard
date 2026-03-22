/*
 * ESP32 Gas Sensor Dashboard — Backend Server
 * =============================================
 * Queries DynamoDB for sensor data and serves it to the browser via REST + WebSocket.
 */

const express = require('express');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

// ─────────────────────────────────────────────
//  Configuration
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const AWS_REGION = process.env.AWS_REGION || 'ap-south-1';
const TABLE_NAME = process.env.DYNAMO_TABLE || 'gas_sensor_data';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '10000'); // ms

// ─────────────────────────────────────────────
//  AWS DynamoDB client
// ─────────────────────────────────────────────
const ddbClient = new DynamoDBClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const docClient = DynamoDBDocumentClient.from(ddbClient);

// ─────────────────────────────────────────────
//  Express + HTTP server
// ─────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─────────────────────────────────────────────
//  REST API endpoints
// ─────────────────────────────────────────────

// Get recent readings for a specific device
app.get('/api/data/:deviceId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '100');
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'device_id = :did',
      ExpressionAttributeValues: { ':did': req.params.deviceId },
      ScanIndexForward: false, // newest first
      Limit: limit,
    }));
    res.json({ items: (result.Items || []).reverse(), count: result.Count });
  } catch (err) {
    console.error('[API] Query error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get list of all devices
app.get('/api/devices', async (req, res) => {
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      ProjectionExpression: 'device_id',
    }));
    const devices = [...new Set((result.Items || []).map(i => i.device_id))];
    res.json({ devices });
  } catch (err) {
    console.error('[API] Scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get latest reading for all devices
app.get('/api/latest', async (req, res) => {
  try {
    // First get device list
    const scanResult = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      ProjectionExpression: 'device_id',
    }));
    const devices = [...new Set((scanResult.Items || []).map(i => i.device_id))];

    // Get latest reading for each device
    const latest = {};
    for (const did of devices) {
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'device_id = :did',
        ExpressionAttributeValues: { ':did': did },
        ScanIndexForward: false,
        Limit: 1,
      }));
      if (result.Items && result.Items.length > 0) {
        latest[did] = result.Items[0];
      }
    }
    res.json({ devices: latest });
  } catch (err) {
    console.error('[API] Latest error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  WebSocket server — push updates to browsers
// ─────────────────────────────────────────────
const wss = new WebSocketServer({ server });
let lastTimestamps = {}; // track per-device latest timestamp

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => console.log('[WS] Client disconnected'));
});

// Heartbeat to detect dead connections
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Poll DynamoDB and broadcast new data to all connected browsers
async function pollAndBroadcast() {
  try {
    // Get all device IDs
    const scanResult = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      ProjectionExpression: 'device_id',
    }));
    const devices = [...new Set((scanResult.Items || []).map(i => i.device_id))];

    for (const did of devices) {
      const result = await docClient.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'device_id = :did',
        ExpressionAttributeValues: { ':did': did },
        ScanIndexForward: false,
        Limit: 5,
      }));

      const items = result.Items || [];
      const newItems = items.filter(item => {
        const ts = item.timestamp || 0;
        return ts > (lastTimestamps[did] || 0);
      });

      if (newItems.length > 0) {
        lastTimestamps[did] = Math.max(...newItems.map(i => i.timestamp || 0));
        const message = JSON.stringify({ type: 'data', items: newItems.reverse() });
        wss.clients.forEach(ws => {
          if (ws.readyState === 1) ws.send(message);
        });
      }
    }
  } catch (err) {
    console.error('[Poll] Error:', err.message);
  }
}

setInterval(pollAndBroadcast, POLL_INTERVAL);

// ─────────────────────────────────────────────
//  Start server
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  ┌─────────────────────────────────────────┐`);
  console.log(`  │  Gas Sensor Dashboard                   │`);
  console.log(`  │  http://localhost:${PORT}                  │`);
  console.log(`  │  Region: ${AWS_REGION}                  │`);
  console.log(`  │  Table:  ${TABLE_NAME}            │`);
  console.log(`  └─────────────────────────────────────────┘\n`);
});
