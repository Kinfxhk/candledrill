// SPDX-License-Identifier: AGPL-3.0-or-later

interface Health {
  status: string;
  version: string;
  telemetry: boolean;
}

async function checkHealth(): Promise<void> {
  const el = document.getElementById('status');
  if (!el) return;
  try {
    const res = await fetch('/api/health');
    const body = (await res.json()) as Health;
    el.textContent = `Local server: ${body.status} (v${body.version}, telemetry: ${String(body.telemetry)})`;
  } catch {
    el.textContent = 'Local server not reachable. Start it with: npm run dev:server';
  }
}

void checkHealth();
