import http from 'http';
import https from 'https';
import axios from 'axios';

const MAX_SOCKETS = 10;

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: MAX_SOCKETS,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: MAX_SOCKETS,
});

export const httpClient = axios.create({
  httpAgent,
  httpsAgent,
  timeout: 15000,
  maxRedirects: 5,
  validateStatus: () => true,
});
