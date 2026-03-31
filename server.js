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

// 🔥 IMPORTANT: serve your existing UI
app.use(express.static(path.join(__dirname, 'public')));

// ================= API =================

// devices
app.get('/api/devices', async (req, res) => {
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      ProjectionExpression: 'device_id'
    }));

    const devices = [...new Set((result.Items || []).map(i => i.device_id))];
    res.json({ devices });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// data per device
app.get('/api/data/:deviceId', async (req, res) => {
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'device_id = :d',
      ExpressionAttributeValues: { ':d': req.params.deviceId },
      ScanIndexForward: false,
      Limit: 100
    }));

    const items = (result.Items || []).map(item => ({
      device_id: item.device_id,
      gas_ppm: item.gas_value, // 🔥 mapping
      raw_adc: item.raw_adc || 0,
      wifi_rssi: item.wifi_rssi || -60,
      alert: (item.gas_value || 0) > 300,
      timestamp: item.timestamp,
      aws_timestamp: new Date(item.timestamp).getTime()
    }));

    res.json({ items: items.reverse() });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= WEBSOCKET =================

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log("Client connected");
});

// polling DynamoDB
setInterval(async () => {
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      Limit: 20
    }));

    const items = (result.Items || []).map(item => ({
      device_id: item.device_id,
      gas_ppm: item.gas_value,
      raw_adc: item.raw_adc || 0,
      wifi_rssi: item.wifi_rssi || -60,
      alert: (item.gas_value || 0) > 300,
      timestamp: item.timestamp,
      aws_timestamp: new Date(item.timestamp).getTime()
    }));

    const message = JSON.stringify({
      type: "data",
      items
    });

    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(message);
    });

  } catch (err) {
    console.log(err.message);
  }

}, 5000);

// ================= START =================

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});