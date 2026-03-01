(() => {
  const leftScoreEl = document.getElementById('left-score');
  const rightScoreEl = document.getElementById('right-score');
  const statusEl = document.getElementById('status');
  const controlsEl = document.getElementById('controls');
  const resetBtn = document.getElementById('manual-reset');

  const params = new URLSearchParams(window.location.search);
  const displayOnly = params.get('display') === '1';
  if (displayOnly) {
    document.body.classList.add('display-only');
  }

  function paint(state) {
    leftScoreEl.textContent = String(state.left ?? 0);
    rightScoreEl.textContent = String(state.right ?? 0);
    statusEl.textContent = `Live · ${state.lastAction || 'ready'}`;
  }

  async function sendButton(side, event) {
    const response = await fetch('/api/button', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ side, event }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || 'Request failed');
    }

    const payload = await response.json();
    paint(payload.state);
  }

  async function resetAll() {
    const response = await fetch('/api/reset', { method: 'POST' });
    if (!response.ok) throw new Error('Reset failed');
    const payload = await response.json();
    paint(payload.state);
  }

  if (controlsEl && !displayOnly) {
    controlsEl.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-side][data-event]');
      if (!button) return;

      const side = button.getAttribute('data-side');
      const type = button.getAttribute('data-event');

      try {
        await sendButton(side, type);
      } catch (error) {
        statusEl.textContent = `Error · ${error.message}`;
      }
    });
  }

  if (resetBtn && !displayOnly) {
    resetBtn.addEventListener('click', async () => {
      try {
        await resetAll();
      } catch (error) {
        statusEl.textContent = `Error · ${error.message}`;
      }
    });
  }

  const HOLD_MS = 2000;
  const keyState = {
    a: { side: 'left', down: false, held: false, timer: null },
    s: { side: 'right', down: false, held: false, timer: null },
  };

  function clearHoldTimer(key) {
    const state = keyState[key];
    if (!state || !state.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
  }

  async function onSideKeyDown(key) {
    const state = keyState[key];
    if (!state || state.down) return;

    state.down = true;
    state.held = false;
    clearHoldTimer(key);

    state.timer = setTimeout(async () => {
      if (!state.down || state.held) return;
      try {
        await sendButton(state.side, 'hold');
        state.held = true;
      } catch (error) {
        statusEl.textContent = `Error · ${error.message}`;
      }
    }, HOLD_MS);
  }

  async function onSideKeyUp(key, shiftKey) {
    const state = keyState[key];
    if (!state || !state.down) return;

    state.down = false;
    clearHoldTimer(key);

    if (state.held) {
      state.held = false;
      return;
    }

    try {
      await sendButton(state.side, shiftKey ? 'double' : 'tap');
    } catch (error) {
      statusEl.textContent = `Error · ${error.message}`;
    }
  }

  window.addEventListener('keydown', async (event) => {
    if (displayOnly) return;

    const key = event.key.toLowerCase();
    if (event.repeat && (key === 'a' || key === 's')) return;

    if (key === 'a' || key === 's') {
      await onSideKeyDown(key);
      return;
    }

    if (key === 'r') {
      try {
        await resetAll();
      } catch (error) {
        statusEl.textContent = `Error · ${error.message}`;
      }
    }
  });

  window.addEventListener('keyup', async (event) => {
    if (displayOnly) return;

    const key = event.key.toLowerCase();
    if (key === 'a' || key === 's') {
      await onSideKeyUp(key, event.shiftKey);
    }
  });

  window.addEventListener('blur', () => {
    Object.keys(keyState).forEach((key) => {
      keyState[key].down = false;
      keyState[key].held = false;
      clearHoldTimer(key);
    });
  });

  fetch('/api/state')
    .then((res) => res.json())
    .then((data) => paint(data))
    .catch(() => {
      statusEl.textContent = 'Offline';
    });

  const stream = new EventSource('/events');
  stream.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      paint(data);
    } catch {
      statusEl.textContent = 'Stream parse error';
    }
  };

  stream.onerror = () => {
    statusEl.textContent = 'Reconnecting...';
  };
})();
