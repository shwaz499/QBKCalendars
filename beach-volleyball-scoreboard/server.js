var http = require('http');
var fs = require('fs');
var path = require('path');

var PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
var HOST = process.env.HOST || '0.0.0.0';

var DOUBLE_PRESS_WINDOW_MS = 450;
var LONG_HOLD_MS = 2000;

var state = {
  left: 0,
  right: 0,
  lastAction: 'ready',
  updatedAt: new Date().toISOString(),
};

var buttonTrack = {
  left: { pressedAt: null, pendingTapTimer: null },
  right: { pressedAt: null, pendingTapTimer: null },
};

var sseClients = [];

function nowIso() {
  return new Date().toISOString();
}

function clampMinZero(value) {
  return value < 0 ? 0 : value;
}

function sendSseToAll(payload) {
  var aliveClients = [];
  for (var i = 0; i < sseClients.length; i += 1) {
    var res = sseClients[i];
    if (!res.writableEnded) {
      try {
        res.write(payload);
        aliveClients.push(res);
      } catch (e) {
        // Drop dead client.
      }
    }
  }
  sseClients = aliveClients;
}

function pushState(lastAction) {
  state.lastAction = lastAction;
  state.updatedAt = nowIso();
  var payload = 'data: ' + JSON.stringify(state) + '\n\n';
  sendSseToAll(payload);
}

function addPoint(side) {
  state[side] += 1;
  pushState(side + ':add');
}

function subtractPoint(side) {
  state[side] = clampMinZero(state[side] - 1);
  pushState(side + ':subtract');
}

function resetScore(reason) {
  state.left = 0;
  state.right = 0;
  pushState(reason || 'reset');
}

function clearPendingTap(side) {
  var t = buttonTrack[side];
  if (t.pendingTapTimer) {
    clearTimeout(t.pendingTapTimer);
    t.pendingTapTimer = null;
  }
}

function handleTap(side) {
  var t = buttonTrack[side];

  if (t.pendingTapTimer) {
    clearPendingTap(side);
    subtractPoint(side);
    return;
  }

  t.pendingTapTimer = setTimeout(function () {
    t.pendingTapTimer = null;
    addPoint(side);
  }, DOUBLE_PRESS_WINDOW_MS);
}

function handleHoldReset(side) {
  clearPendingTap(side);
  resetScore(side + ':hold-reset');
}

function processButtonEvent(side, eventType, durationMs) {
  if (side !== 'left' && side !== 'right') {
    throw new Error('Invalid side. Use "left" or "right".');
  }

  var t = buttonTrack[side];

  if (eventType === 'tap') {
    handleTap(side);
    return;
  }

  if (eventType === 'double') {
    clearPendingTap(side);
    subtractPoint(side);
    return;
  }

  if (eventType === 'hold') {
    handleHoldReset(side);
    return;
  }

  if (eventType === 'press') {
    t.pressedAt = Date.now();
    return;
  }

  if (eventType === 'release') {
    var heldMs = 0;
    if (typeof durationMs === 'number') {
      heldMs = durationMs;
    } else if (t.pressedAt) {
      heldMs = Date.now() - t.pressedAt;
    }

    t.pressedAt = null;

    if (heldMs >= LONG_HOLD_MS) {
      handleHoldReset(side);
    } else {
      handleTap(side);
    }
    return;
  }

  if (eventType === 'reset') {
    resetScore(side + ':explicit-reset');
    return;
  }

  throw new Error('Invalid event. Use tap, double, hold, press, release, or reset.');
}

function serveFile(filePath, contentType, res) {
  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function parseJsonBody(req, callback) {
  var raw = '';

  req.on('data', function (chunk) {
    raw += chunk;
    if (raw.length > 1000000) {
      callback(new Error('Body too large'));
    }
  });

  req.on('end', function () {
    if (!raw) {
      callback(null, {});
      return;
    }

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      callback(new Error('Invalid JSON'));
      return;
    }

    callback(null, parsed);
  });

  req.on('error', function (err) {
    callback(err);
  });
}

function pathnameOf(urlValue) {
  var q = urlValue.indexOf('?');
  return q >= 0 ? urlValue.slice(0, q) : urlValue;
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

var server = http.createServer(function (req, res) {
  var pathname = pathnameOf(req.url || '/');

  if (req.method === 'GET' && pathname === '/') {
    serveFile(path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8', res);
    return;
  }

  if (req.method === 'GET' && pathname === '/styles.css') {
    serveFile(path.join(__dirname, 'public', 'styles.css'), 'text/css; charset=utf-8', res);
    return;
  }

  if (req.method === 'GET' && pathname === '/client.js') {
    serveFile(path.join(__dirname, 'public', 'client.js'), 'application/javascript; charset=utf-8', res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/state') {
    json(res, 200, state);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/reset') {
    resetScore('manual-reset');
    json(res, 200, { ok: true, state: state });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/button') {
    parseJsonBody(req, function (error, body) {
      if (error) {
        json(res, 400, { ok: false, error: error.message });
        return;
      }

      try {
        processButtonEvent(body.side, body.event, body.durationMs);
        json(res, 200, { ok: true, state: state });
      } catch (e) {
        json(res, 400, { ok: false, error: e.message });
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    res.write('data: ' + JSON.stringify(state) + '\n\n');
    sseClients.push(res);

    req.on('close', function () {
      var idx = sseClients.indexOf(res);
      if (idx >= 0) sseClients.splice(idx, 1);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, HOST, function () {
  console.log('Beach volleyball scorer running on http://' + HOST + ':' + PORT);
});
