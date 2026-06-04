const express = require('express');
const renderStSimulasi = require('./lib/webui-st-simulasi');
const renderBacktestSt = require('./lib/webui-backtest-st');
const renderPerpetualMs = require('./lib/webui-perpetual-ms');

const app = express();
const PORT = 3030;

app.get('/', (req, res) => {
  const stHtml = renderStSimulasi();
  const btHtml = renderBacktestSt();
  const perpHtml = renderPerpetualMs();

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Indikratos — Terminal</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #00ff00; font-family: 'Courier New', monospace; padding: 12px 16px 60px; font-size: 13px; line-height: 1.5; }
  h1, h2, h3 { color: #00cc00; margin: 10px 0 6px; font-weight: normal; }
  h1 { font-size: 16px; border-bottom: 1px solid #00ff00; padding-bottom: 4px; }
  h2 { font-size: 14px; }
  h3 { font-size: 13px; }
  .status-bar { background: #111; border: 1px solid #333; padding: 6px 10px; margin-bottom: 10px; font-size: 12px; }
  .stats-bar { background: #111; border: 1px solid #333; padding: 6px 10px; margin-bottom: 8px; font-size: 12px; }
  .stats-bar span { margin-right: 14px; }
  .pos { color: #00ff00; }
  .neg { color: #ff4444; }
  .neutral { color: #888; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 12px; }
  th, td { border: 1px solid #333; padding: 3px 6px; text-align: left; }
  th { background: #1a1a1a; color: #00cc00; font-weight: normal; }
  tr:hover td { background: #111; }
  .tab-container { margin-bottom: 8px; position: sticky; top: 0; background: #0a0a0a; padding: 4px 0; z-index: 10; }
  .tab { display: inline-block; padding: 5px 14px; cursor: pointer; border: 1px solid #333; margin-right: 4px; font-family: 'Courier New', monospace; font-size: 12px; background: #111; color: #888; }
  .tab.active { background: #1a3a1a; color: #00ff00; border-color: #00ff00; }
  .tab:hover { color: #00ff00; }
  .panel { display: none; }
  .panel.active { display: block; }
  .badge { padding: 1px 6px; font-size: 11px; border-radius: 2px; }
  .badge-win { background: #003300; color: #00ff00; }
  .badge-lose { background: #330000; color: #ff4444; }
  @media (max-width: 640px) {
    body { padding: 6px 8px 60px; font-size: 11px; }
    th, td { padding: 2px 4px; font-size: 11px; }
    .tab { padding: 4px 8px; font-size: 11px; }
  }
</style>
</head>
<body>
<div style="max-width:1100px;margin:0 auto">

<h1>╔═ INDIKRATOS ═══════╗</h1>
<div class="status-bar">
  <span>⏱ <span id="timer">0</span>s</span>
  <span>⟳ <span id="nextPoll">0</span>s</span>
  <span style="float:right">$(date '+%Y-%m-%d %H:%M:%S')</span>
</div>

<div class="tab-container">
  <span class="tab active" data-tab="simulator">📈 Simulator</span>
  <span class="tab" data-tab="backtest">📊 Backtest</span>
  <span class="tab" data-tab="perpetual">🔁 Perpetual MS</span>
</div>

<div class="panel active" id="panel-simulator">${stHtml}</div>
<div class="panel" id="panel-backtest">${btHtml}</div>
<div class="panel" id="panel-perpetual">${perpHtml}</div>

</div>

<script>
(function() {
  const tabs = document.querySelectorAll('.tab');
  const panels = {
    simulator: document.getElementById('panel-simulator'),
    backtest: document.getElementById('panel-backtest'),
    perpetual: document.getElementById('panel-perpetual'),
  };
  const saved = localStorage.getItem('indikratos_tab');
  if (saved && panels[saved]) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === saved));
    Object.values(panels).forEach(p => p.classList.remove('active'));
    panels[saved].classList.add('active');
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      Object.values(panels).forEach(p => p.classList.remove('active'));
      if (panels[name]) panels[name].classList.add('active');
      localStorage.setItem('indikratos_tab', name);
    });
  });

  let seconds = 0, nextPoll = 3;
  const timerEl = document.getElementById('timer');
  const pollEl = document.getElementById('nextPoll');
  setInterval(() => {
    seconds++;
    nextPoll--;
    if (nextPoll <= 0) nextPoll = 3;
    if (timerEl) timerEl.textContent = seconds;
    if (pollEl) pollEl.textContent = nextPoll;
  }, 1000);

  setInterval(() => {
    const active = document.querySelector('.tab.active');
    const name = active ? active.dataset.tab : 'simulator';
    fetch('/refresh/' + name)
      .then(r => r.text())
      .then(html => {
        const panel = document.getElementById('panel-' + name);
        if (panel) panel.innerHTML = html;
        seconds = 0;
      })
      .catch(() => {});
  }, 3000);
})();
</script>
</body>
</html>`);
});

app.get('/refresh/:tab', (req, res) => {
  const tab = req.params.tab;
  if (tab === 'simulator') return res.send(renderStSimulasi());
  if (tab === 'backtest') return res.send(renderBacktestSt());
  if (tab === 'perpetual') return res.send(renderPerpetualMs());
  res.status(404).send('Not found');
});

app.listen(PORT, () => console.log('🌐 WebUI on http://localhost:' + PORT));
