# CandleDrill（K線操練場）

**CandleDrill**（中文：**K線操練場**）是免費、開源的 **K 線回放練習工具**。在**同一台電腦**上自架服務，用**桌面瀏覽器**開啟介面：匯入 K 線 → 逐根前進（看不到未來）→ 模擬下單 → 檢討結果。無需帳戶、無訂閱、無遙測。**不構成投資建議。**

> **優勢：** Web 介面、本機自架——服務預設只聽 `127.0.0.1`，請在**執行 CandleDrill 的那台電腦**上，用桌面瀏覽器開啟。同一台電腦的其他瀏覽器視窗／分頁亦可。產品**不會**改聽區網位址；若要在家裡其他裝置使用，見下方「其他裝置（安全隧道）」。**請勿**把服務直接發佈到區網或公網（無登入機制）。

> **v0.5.0** · 僅供本機練習。問題請開 [Issues](https://github.com/Kinfxhk/candledrill/issues)。[CHANGELOG](CHANGELOG.md)

![CandleDrill 練習畫面：雙時框、Long R 繪圖、括號單、下單票與成交紀錄](docs/screenshot.png)

<sub>截圖使用產生的 `SYNTH-` 示範資料，並非真實市價。</sub>

完整教學：[docs/guide.zh-Hant.md](docs/guide.zh-Hant.md)

## 風險聲明

CandleDrill 是**教育與練習工具**。**不構成投資建議**，不提供交易訊號，**模擬或練習成績不能預示真實交易結果**。期貨、外匯等槓桿商品可能損失超過本金。以 K 棒為單位的模擬，無法還原一根棒內真實的價格先後順序。若資料源比練習時框更細（例如 10 秒），圖表可用其更新 forming 1 分鐘 K；**成交仍只在練習時框收棒時發生**（見 [docs/FILL-MODEL.md](docs/FILL-MODEL.md)）。

## 安裝（約 5 分鐘）

需要一台桌面電腦與 [Node.js 22+](https://nodejs.org/)（LTS 即可）。

```bash
git clone https://github.com/Kinfxhk/candledrill.git
cd candledrill
npm ci
npm start
```

在**本機**開啟 <http://127.0.0.1:4870/> → **Generate demo data** → 填寫練習表單 → **Start practising**。

資料留在本機（`~/.candledrill/`）。若要使用 Docker，見下方「補充說明」。

## 其他裝置（安全隧道）

CandleDrill **預設只聽** `127.0.0.1`，程式不會改成區網 listen。若你要在家裡用平板或其他電腦練習，請自行架設安全隧道，例如 **Tailscale**，或 **SSH 本地埠轉發**（把遠端本機的 `127.0.0.1:4870` 轉到你手邊裝置），再以瀏覽器連線。

**請勿**把埠直接 publish／對映到區網或公網——沒有登入機制。細節見 [SECURITY.md](SECURITY.md)。

## 練習資料

- **一鍵示範：** **Generate demo data** 會產生合成 **10 秒** K 線（`SYNTH-…`）；練習畫面預設 1 分鐘圖，forming 會隨 10 秒更新，成交仍跟 1 分鐘收棒。相同種子 → 相同 K 線。
- **較長的 Globex 風格樣本（僅合成）：**  
  [`Kinfxhk/candledrill-synth-samples`](https://github.com/Kinfxhk/candledrill-synth-samples)  
  匯入 `SYNTH-NQ-GLOBEX_1min.csv`，代號 **`PRACTICE-NQ-GLOBEX`**，tick 大小 **`0.25`**，UTC 偏移 **`-300`**。
- 或 **Import CSV** 匯入你有權使用的資料。CandleDrill **不附帶**真實市場資料。

## 功能

### 盲練（Blind practice）

隱藏真實代號，並偏移日期與價格，避免一眼認出圖表。結束後再揭曉。

![盲練：代號顯示為 Blind、Reveal 控制、偽裝後的圖表](docs/shot-blind.png)

<sub>**盲練** — 隨機起點、偽裝代號／日期／價格；Reveal 還原真相。底層為產生的 `SYNTH-` 示範資料。</sub>

### 繪圖工具

浮動 **Draw** 工具列：水平線／趨勢線／矩形、文字、箭頭、自由繪、Long R／Short R。再按一次 **Draw** 可收合；Clear 會要求確認。

![浮動 Draw 工具列開啟，圖上有趨勢線](docs/shot-drawings.png)

<sub>**繪圖工具列** — 圖上可收合的工具（不重複放在頂部列）。合成 `SYNTH-` 示範資料。</sub>

### 雙時框

分割畫面，十字線與捲動連動。各窗格可改時框（1 分 → 日線）。

![雙圖：1 分與 15 分連動](docs/shot-multitf.png)

<sub>**多時框** — 同一時刻在兩張圖練習，不偷看未來。合成 `SYNTH-` 示範資料。</sub>

### 技術指標

可搜尋目錄：SMA／EMA（任意週期）、布林通道、盤中 VWAP、開盤區間（ORB）、唐奇安、RSI、MACD、ATR、隨機指標、ADX——只根據**已揭示**的 K 棒計算。設定留在本瀏覽器（`candledrill.indicators.v2`）。

![指標面板：已啟用 SMA 9/20/50 與 RSI](docs/shot-indicators.png)

<sub>**指標** — 疊加線與下方視窗；設定只留在本機。合成 `SYNTH-` 示範資料。</sub>

### 半自動交易（Semi-auto）

從圖上的 **Semi-auto**／**半自動**，或底部分頁 **半自動交易** 開啟；須為**非盲練**場次。四步：**條件 → 進出場 → 執行 → 結果**。

1. 選擇指標與反應，再按 **Add**／**新增**。快速套用為選用。
2. 設定數量、方向、停損與目標。
3. 出現綠色就緒列後，可 **Backtest**（**From start**｜**From here**，書面語：由開始／由目前位置）或 **Follow while playing**（播放時跟隨）。介面標籤可能與書面語略有不同。按鈕呈灰色表示尚缺欄位。
4. 結果卡一律顯示：統計、0 筆成交及原因，或尚未執行。

僅本機模擬，不連接券商；右側手動下單票仍可使用。條件語法與 API 見 [docs/MACRO.md](docs/MACRO.md)。

![半自動第 3 步：綠色就緒列，可回測或播放時跟隨](docs/shot-semi-run.png)

<sub>**半自動 — 執行** — 合成 `SYNTH-` 資料，非真實市價。綠色表示可回測或播放時跟隨。</sub>

![半自動第 4 步：模擬跑完後的結果卡](docs/shot-semi-result.png)

<sub>**半自動 — 結果** — 合成 `SYNTH-` 資料，非真實市價。此例為 0 筆成交，卡片會說明原因。</sub>

### 下單與檢討

市價／限價／停損、括號單（SL／TP）、風險預覽、一鍵平倉。成交、日誌、統計，以及 CSV／HTML／場次匯出。可選練習規則（每日虧損、追蹤回撤、獲利目標）。某條規則留空即表示關閉。

#### 練習規則

新建場次表單有兩種「時鐘」，用途不同：

- **開市錨點**（`anchorMinutes`）：開盤區間（ORB）、盤中 VWAP，以及半自動 `orb_break` 視窗所用的開市時鐘。選擇資料集時，會依第一根棒的交易所本地時間填入。
- **交易日開始**（`dayStartMinutes`）：僅作為每日虧損限制的日界——每日虧損何時重置。

**追蹤回撤模式**（`trailingDrawdownMode`）預設為 `close`。它只影響追蹤回撤規則；每日虧損仍以該棒收盤權益為準。

- `close` — 峰值隨每根棒收盤權益更新。棒內波動不計入。
- `eod` — 峰值僅在交易日界（日終）更新。
- `intraday` — 峰值採有利高低點；觸發則以不利高低點計，並於該價平倉。
- `static` — 底線固定為起始資金減去設定金額，不跟隨峰值。

舊場次檔仍可匯入：`anchorMinutes` 會複製自 `dayStartMinutes`，模式為 `close`。於 [0.4.0](CHANGELOG.md) 新增。成交規則見 [docs/FILL-MODEL.md](docs/FILL-MODEL.md)。

## 為何選擇 CandleDrill

- **永久免費** — 無付費層級、無廣告、無追蹤、無需帳戶。
- **僅本機 loopback** — 伺服器只綁定 `127.0.0.1`；單一 SQLite 檔可自行備份。**請勿**直接暴露到區網或公網（無登入）；其他裝置請用安全隧道（見上）。
- **成交規則公開** — 規則與限制有文件說明（[docs/FILL-MODEL.md](docs/FILL-MODEL.md)）。
- **桌面瀏覽器** — 介面以桌面瀏覽器為主；不為手機視窗設計。家中其他裝置請用 Tailscale／SSH 轉發，勿直接開區網埠。
- 獨立專案；**與** FX Replay、Forex Tester、TradeZella、TradingView 或任何券商／交易所**無關**。

## 補充說明

<details>
<summary>Docker</summary>

```bash
docker compose up --build    # http://127.0.0.1:4870/
```

在主機上僅發佈 **127.0.0.1**。切勿將 CandleDrill 暴露到網路——沒有登入機制。

</details>

<details>
<summary>CSV 匯入提示</summary>

每列一根棒：時間戳、開、高、低、收，可選成交量。匯入對話框會嘗試猜測欄位。無時區的時間會套用你選擇的 UTC 偏移。可匯入 10 秒等細週期；練習畫面時框選單仍從 1 分鐘起，forming 1 分鐘由細源更新，成交跟練習時框收棒。只匯入你有權使用的資料。

</details>

<details>
<summary>資料備份／還原</summary>

- 預設資料庫：`~/.candledrill/candledrill.db`（Windows：`%USERPROFILE%\.candledrill\`）。
- 在資料庫（Library）使用 **Back up everything**／**Restore from backup**。
- 環境變數：`CANDLEDRILL_PORT`（4870）、`CANDLEDRILL_DATA_DIR`、`CANDLEDRILL_DB`。主機位址必須維持 `127.0.0.1`。

</details>

<details>
<summary>成交方式（簡述）</summary>

訂單只會在下單**之後**揭示的 K 棒上成交。市價 → 下一根開盤 ± 滑價。限價／停損若跳空穿過 → 以開盤成交（停損再加滑價）。同一根棒同時觸及 SL 與 TP 時，**先停損**。完整規則：[docs/FILL-MODEL.md](docs/FILL-MODEL.md)。

</details>

<details>
<summary>開發</summary>

```bash
npm run check          # lint、測試、授權／無市價資料檢查
npm run test:e2e       # Playwright 煙測（需先裝一次 Chromium）
npm run screenshot     # 重新產生 docs/screenshot.png（伺服器須在執行）
node scripts/screenshot-gallery.mjs   # 重新產生 README 各功能截圖
```

結構：`packages/core`（引擎）、`packages/server`（Fastify + SQLite）、`packages/web`（介面）。  
更多：[docs/PERFORMANCE.md](docs/PERFORMANCE.md)、[SECURITY.md](SECURITY.md)、[CONTRIBUTING.md](CONTRIBUTING.md)。

</details>

## 授權

[GNU Affero General Public License v3.0 or later](LICENSE)（AGPL-3.0-or-later）。  
第三方聲明：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。圖表：[TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/)（Apache-2.0）。

## 支持開發

CandleDrill 免費，也會持續免費。若這個工具對你有幫助：https://buymeacoffee.com/kinfxhk

---

# CandleDrill (English)

**CandleDrill** (Chinese: **K線操練場**) is a free, open-source **candlestick replay practice** tool. Self-host on **one computer** and open the **desktop browser UI on that same machine**: load bars → step without seeing the future → place simulated orders → review. No account, no subscription, no telemetry. **Not investment advice.**

> **Web UI:** local service + desktop browser on the machine that runs CandleDrill. Other tabs/windows on **that** computer are fine. The server listens on **`127.0.0.1` by default** and does **not** bind to your LAN. For another device at home, use a secure tunnel (see **Other devices** below). **Do not** publish the port to your LAN or the public internet (no login).

> **v0.5.0** · Local practice only. Bugs: [Issues](https://github.com/Kinfxhk/candledrill/issues). [CHANGELOG](CHANGELOG.md)

![CandleDrill practice: two timeframes, Long R drawing, open bracket, order ticket and trade log](docs/screenshot.png)

<sub>Screenshot uses generated `SYNTH-` demo data, not real market prices.</sub>

Traditional Chinese guide: [docs/guide.zh-Hant.md](docs/guide.zh-Hant.md)

## Risk notice

CandleDrill is an **educational practice tool**. It is **not investment advice**,
it gives no trading signals, and **simulated or practice results do not predict
real trading results**. Trading futures, forex and other leveraged products can
lose more than your deposit. Bar-based simulation cannot know the true order of
prices inside a bar. If the data source is finer than the practice timeframe (for example 10s bars while you watch 1m), the chart may use those bars to update a forming 1m candle; **fills still occur only on practice-timeframe closes** (see [docs/FILL-MODEL.md](docs/FILL-MODEL.md)).

## Install (about 5 minutes)

You need a desktop computer and [Node.js 22+](https://nodejs.org/) (LTS is fine).

```bash
git clone https://github.com/Kinfxhk/candledrill.git
cd candledrill
npm ci
npm start
```

Open <http://127.0.0.1:4870/> on **this machine** → **Generate demo data** → fill the session form → **Start practising**.

Data stays on your machine (`~/.candledrill/`). Prefer Docker? See [Quick extras](#quick-extras) below.

## Other devices (secure tunnel)

CandleDrill listens on **`127.0.0.1` only** by design. It will not switch to a LAN listen address. To practise from a tablet or another computer at home, set up your own secure tunnel — for example **Tailscale**, or **SSH local port forwarding** (forward the host’s `127.0.0.1:4870` to the device in your hand) — then open the UI in a browser.

**Do not** publish / map the port onto your LAN or the public internet — there is no login. See [SECURITY.md](SECURITY.md).

## Practice data

- **One-click demo:** **Generate demo data** creates synthetic **10s** bars (`SYNTH-…`); the practice UI defaults to a 1m pane so forming updates from 10s, while fills still follow 1m closes. Same seed → same bars.
- **Longer Globex-like sample (synthetic only):**  
  [`Kinfxhk/candledrill-synth-samples`](https://github.com/Kinfxhk/candledrill-synth-samples)  
  Import `SYNTH-NQ-GLOBEX_1min.csv` as symbol **`PRACTICE-NQ-GLOBEX`**, tick size **`0.25`**, UTC offset **`-300`**.
- Or **Import CSV** of data you are entitled to use. CandleDrill ships **no real market data**.

## What you can do

### Blind practice

Hide the real symbol, shift dates and prices so you cannot recognise the chart. Reveal when finished.

![Blind practice: symbol shown as Blind, Reveal control, disguised chart](docs/shot-blind.png)

<sub>**Blind practice** — random start, disguised symbol/dates/prices; Reveal restores the truth. Underlying bars are generated `SYNTH-` demo data.</sub>

### Drawing tools

Floating **Draw** palette: horizontal / trend / rectangle, text, arrow, freehand, Long R / Short R. Click **Draw** again to collapse; Clear asks for confirmation.

![Floating Draw palette open with trend line on the chart](docs/shot-drawings.png)

<sub>**Drawing palette** — collapsible tools on the chart. Synthetic `SYNTH-` demo data.</sub>

### Two timeframes

Split view with linked crosshair and scroll. Change each pane’s timeframe (1m → daily).

![Two charts: 1m and 15m linked](docs/shot-multitf.png)

<sub>**Multi-timeframe** — practise the same moment on two charts without look-ahead. Synthetic `SYNTH-` demo data.</sub>

### Indicators

Searchable catalog: SMA / EMA (any periods), Bollinger, session VWAP, opening range (ORB), Donchian, RSI, MACD, ATR, Stochastic, ADX — computed only on bars already revealed. Settings stay in this browser (`candledrill.indicators.v2`).

![Indicators panel with SMA 9/20/50 and RSI enabled](docs/shot-indicators.png)

<sub>**Indicators** — overlays and lower panes; settings stay on this computer only. Synthetic `SYNTH-` demo data.</sub>

### Semi-auto

Open the chart chip **Semi-auto**, or the bottom tab. Needs a **non-blind** session. Four steps: **Conditions → Entry & exit → Run → Result**.

1. Pick an indicator, pick a reaction, then **Add**. Quick-apply chips are optional.
2. Set quantity, side, stop, and target.
3. A green ready line, then **Backtest** (**From start** | **From here**) or **Follow while playing**. Grey means a field is still missing.
4. The result card is always there: stats, 0 trades and a reason, or not run yet.

Simulated only — no broker. The manual ticket stays on the right. DSL and API: [docs/MACRO.md](docs/MACRO.md).

![Semi-auto step 3: green ready line, then Backtest or Follow while playing](docs/shot-semi-run.png)

<sub>**Semi-auto — Run** — synthetic `SYNTH-` data. Green means Backtest or Follow while playing is available.</sub>

![Semi-auto step 4: result card after a simulated run](docs/shot-semi-result.png)

<sub>**Semi-auto — Result** — synthetic `SYNTH-` data. This run is 0 trades; the card says why.</sub>

### Orders & review

Market / limit / stop, brackets (SL/TP), risk preview, flatten. Trades, journal, statistics, CSV / HTML / session export. Optional practice rules (daily loss, trailing drawdown, profit target). Leave a rule blank to turn it off.

#### Practice rules

The new-session form has two clocks. They are not the same setting:

- **Market open anchor** (`anchorMinutes`) is the market-open clock for the opening range (ORB), session VWAP, and the semi-auto `orb_break` window. Picking a dataset fills it from the first bar's exchange-local time.
- **Trading day start** (`dayStartMinutes`) is only the daily-loss day boundary: when the daily loss limit resets.

**Trailing drawdown mode** (`trailingDrawdownMode`) defaults to `close`. It only changes the trailing rule. Daily loss still uses equity at the bar close.

- `close` — the peak follows equity at each bar close. A move inside the bar does not count.
- `eod` — the peak updates only at the trading-day boundary (end of day).
- `intraday` — the peak uses the favourable high or low. A breach uses the adverse high or low, and the position closes at that price.
- `static` — the floor stays at starting balance minus the amount. It does not follow a peak.

Older session files still import: `anchorMinutes` copies `dayStartMinutes`, and the mode is `close`. Added in [0.4.0](CHANGELOG.md). Order fills: [docs/FILL-MODEL.md](docs/FILL-MODEL.md).

## Why CandleDrill

- **Free forever** — no paid tiers, ads, tracking, or accounts.
- **Local loopback only** — server binds to `127.0.0.1`; one SQLite file you can back up. Do not publish to LAN/public internet (no login); use a secure tunnel for other devices (see above).
- **Honest fills** — rules and limits are documented ([docs/FILL-MODEL.md](docs/FILL-MODEL.md)).
- **Desktop browsers** — designed for desktop windows. Other home devices: Tailscale / SSH forward — never open a raw LAN port.
- Independent project; **not affiliated with** FX Replay, Forex Tester, TradeZella, TradingView, or any broker/exchange.

## Quick extras

<details>
<summary>Docker</summary>

```bash
docker compose up --build    # http://127.0.0.1:4870/
```

Publishes on the host’s **127.0.0.1 only**. Never expose CandleDrill to a network — it has no login.

</details>

<details>
<summary>CSV import tips</summary>

One row per bar: timestamp, open, high, low, close, optional volume. The import dialog guesses columns. Times without a zone use the UTC offset you choose. You may import 10s (or other fine) bars; the practice pane menu still starts at 1m, forming 1m updates from the fine source, and fills follow practice-TF closes. Only import data you are entitled to use.

</details>

<details>
<summary>Your data (backup / restore)</summary>

- Default DB: `~/.candledrill/candledrill.db` (Windows: `%USERPROFILE%\.candledrill\`).
- **Back up everything** / **Restore from backup** in the Library.
- Env: `CANDLEDRILL_PORT` (4870), `CANDLEDRILL_DATA_DIR`, `CANDLEDRILL_DB`. Host must stay `127.0.0.1`.

</details>

<details>
<summary>How fills work (short)</summary>

Orders fill only on bars revealed **after** placement. Market → next open ± slippage. Limit/stop gap through → fill at open (then slippage for stops). If one bar hits both SL and TP, **stop-loss first**. Full rules: [docs/FILL-MODEL.md](docs/FILL-MODEL.md).

</details>

<details>
<summary>Development</summary>

```bash
npm run check          # lint, tests, licence / no-market-data guards
npm run test:e2e       # Playwright smoke (needs Chromium once)
npm run screenshot     # regenerate docs/screenshot.png (server must be running)
node scripts/screenshot-gallery.mjs   # regenerate all README feature shots
```

Layout: `packages/core` (engine), `packages/server` (Fastify + SQLite), `packages/web` (UI).  
More: [docs/PERFORMANCE.md](docs/PERFORMANCE.md), [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md).

</details>

## Licence

[GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later).  
Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Charts: [TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/) (Apache-2.0).

## Support

CandleDrill is free and will stay free. If it helps you: https://buymeacoffee.com/kinfxhk
