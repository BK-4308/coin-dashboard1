/**
 * 코인 지표 대시보드 - Upbit API 서버 사이드 프록시 (CORS 우회)
 * - GET / : 대시보드 HTML
 * - GET /api/markets : KRW 마켓 목록
 * - GET /api/dashboard?unit=15&count=30 : 거래량·RSI 집계 (정렬용)
 */

const UPBIT_BASE = 'https://api.upbit.com/v1';
const RSI_PERIOD = 14;

type Env = Record<string, unknown>;

/** RSI 계산 (기간 내 종가 배열, 최근이 마지막) */
function calcRSI(closes: number[], period: number = RSI_PERIOD): number | null {
	if (closes.length < period + 1) return null;
	const slice = closes.slice(-(period + 1));
	let gainSum = 0;
	let lossSum = 0;
	for (let i = 1; i < slice.length; i++) {
		const diff = slice[i]! - slice[i - 1]!;
		if (diff > 0) gainSum += diff;
		else lossSum += -diff;
	}
	const avgGain = gainSum / period;
	const avgLoss = lossSum / period;
	if (avgLoss === 0) return 100;
	const rs = avgGain / avgLoss;
	return 100 - 100 / (1 + rs);
}

/** 분 캔들 한 건 타입 */
interface MinuteCandle {
	market: string;
	opening_price: number;
	high_price: number;
	low_price: number;
	trade_price: number;
	candle_acc_trade_volume: number;
	candle_acc_trade_price: number;
	candle_date_time_kst: string;
}

/** 마켓 한 건 타입 */
interface MarketInfo {
	market: string;
	korean_name: string;
	english_name: string;
}

/** 대시보드 행 타입 */
interface DashboardRow {
	market: string;
	korean_name: string;
	trade_price: number;
	volume: number;
	volumePrice: number;
	rsi: number | null;
}

async function fetchKRWMarkets(): Promise<MarketInfo[]> {
	const res = await fetch(`${UPBIT_BASE}/market/all?is_details=false`, {
		signal: AbortSignal.timeout(10000),
	});
	if (!res.ok) throw new Error(`Upbit markets ${res.status}`);
	let list: MarketInfo[];
	try {
		list = (await res.json()) as MarketInfo[];
	} catch {
		throw new Error('Upbit markets invalid JSON');
	}
	if (!Array.isArray(list)) throw new Error('Upbit markets not array');
	return list.filter((m) => m.market.startsWith('KRW-'));
}

async function fetchCandles(unit: number, market: string, count: number): Promise<MinuteCandle[]> {
	const url = `${UPBIT_BASE}/candles/minutes/${unit}?market=${encodeURIComponent(market)}&count=${count}`;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
		if (!res.ok) return [];
		const data = await res.json();
		return Array.isArray(data) ? (data as MinuteCandle[]) : [];
	} catch {
		return [];
	}
}

/** 동시 요청 수 제한 (Upbit 10회/초) */
async function runBatched<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	for (let i = 0; i < items.length; i += concurrency) {
		const chunk = items.slice(i, i + concurrency);
		const chunkResults = await Promise.all(chunk.map(fn));
		results.push(...chunkResults);
		if (i + concurrency < items.length) await new Promise((r) => setTimeout(r, 200));
	}
	return results;
}

function dashboardHTML(): string {
	return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>코인 지표 대시보드</title>
  <style>
    :root { --bg: #0f0f12; --card: #1a1a1f; --text: #e8e8ed; --muted: #888; --accent: #6366f1; --green: #22c55e; --red: #ef4444; }
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 1rem; min-height: 100vh; }
    h1 { font-size: 1.5rem; margin: 0 0 1rem 0; }
    .toolbar { display: flex; gap: 0.75rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; }
    .toolbar select { background: var(--card); color: var(--text); border: 1px solid #333; padding: 0.5rem 0.75rem; border-radius: 8px; }
    .toolbar button { background: var(--accent); color: #fff; border: none; padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; }
    .toolbar button:hover { opacity: 0.9; }
    .toolbar button:disabled { opacity: 0.5; cursor: not-allowed; }
    .loading { color: var(--muted); }
    table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 12px; overflow: hidden; }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #2a2a2f; }
    th { background: #25252c; font-weight: 600; cursor: pointer; user-select: none; }
    th:hover { background: #2e2e36; }
    th.sorted-asc::after { content: ' ▲'; font-size: 0.7em; opacity: 0.8; }
    th.sorted-desc::after { content: ' ▼'; font-size: 0.7em; opacity: 0.8; }
    tr:hover { background: #222228; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .rsi-high { color: var(--red); }
    .rsi-low { color: var(--green); }
    .rsi-mid { color: var(--muted); }
  </style>
</head>
<body>
  <h1>코인 지표 대시보드</h1>
  <div class="toolbar">
    <label>캔들 단위
      <select id="unit">
        <option value="1">1분</option>
        <option value="5">5분</option>
        <option value="15" selected>15분</option>
        <option value="30">30분</option>
        <option value="60">60분</option>
      </select>
    </label>
    <label>캔들 개수
      <select id="count">
        <option value="30">30</option>
        <option value="60">60</option>
        <option value="200">200</option>
      </select>
    </label>
    <label>마켓 수
      <select id="limit">
        <option value="30">30개</option>
        <option value="50" selected>50개</option>
        <option value="100">100개</option>
      </select>
    </label>
    <button type="button" id="refresh">새로고침</button>
    <span id="status" class="loading"></span>
  </div>
  <div style="overflow-x: auto;">
    <table id="table">
      <thead>
        <tr>
          <th data-sort="market">마켓</th>
          <th data-sort="korean_name">한글명</th>
          <th data-sort="trade_price" class="num">현재가</th>
          <th data-sort="volume" class="num">거래량</th>
          <th data-sort="volumePrice" class="num">거래대금</th>
          <th data-sort="rsi" class="num">RSI(14)</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <script>
    const tbody = document.getElementById('tbody');
    const status = document.getElementById('status');
    const table = document.getElementById('table');
    let rows = [];
    let sortKey = 'volume';
    let sortDir = -1;

    function fmtNum(n) {
      if (n >= 1e8) return (n / 1e8).toFixed(2) + '억';
      if (n >= 1e4) return (n / 1e4).toFixed(2) + '만';
      if (n >= 1) return n.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
      return n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
    }
    function rsiClass(rsi) {
      if (rsi == null) return '';
      if (rsi >= 70) return 'rsi-high';
      if (rsi <= 30) return 'rsi-low';
      return 'rsi-mid';
    }
    function render() {
      const sorted = [...rows].sort((a, b) => {
        const va = a[sortKey];
        const vb = b[sortKey];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
      });
      tbody.innerHTML = sorted.map(r => '<tr>' +
        '<td>' + r.market + '</td>' +
        '<td>' + (r.korean_name || '-') + '</td>' +
        '<td class="num">' + fmtNum(r.trade_price) + '</td>' +
        '<td class="num">' + fmtNum(r.volume) + '</td>' +
        '<td class="num">' + fmtNum(r.volumePrice) + '</td>' +
        '<td class="num ' + rsiClass(r.rsi) + '">' + (r.rsi != null ? r.rsi.toFixed(1) : '-') + '</td>' +
        '</tr>').join('');
      table.querySelectorAll('th').forEach(th => {
        th.classList.remove('sorted-asc', 'sorted-desc');
        if (th.dataset.sort === sortKey) th.classList.add(sortDir === 1 ? 'sorted-asc' : 'sorted-desc');
      });
    }
    table.querySelectorAll('th').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (sortKey === key) sortDir *= -1;
        else { sortKey = key; sortDir = key === 'market' || key === 'korean_name' ? 1 : -1; }
        render();
      });
    });
    async function load() {
      status.textContent = '불러오는 중…';
      const unit = document.getElementById('unit').value;
      const count = document.getElementById('count').value;
      const limit = document.getElementById('limit').value;
      try {
        const res = await fetch('/api/dashboard?unit=' + unit + '&count=' + count + '&limit=' + limit);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || res.statusText);
        }
        const data = await res.json();
        rows = data.rows || [];
        status.textContent = data.totalMarkets != null ? rows.length + '/' + data.totalMarkets + '개 마켓' : rows.length + '개 마켓';
        render();
      } catch (e) {
        status.textContent = '오류: ' + e.message;
        rows = [];
        render();
      }
    }
    document.getElementById('refresh').addEventListener('click', () => { document.getElementById('refresh').disabled = true; load().then(() => { document.getElementById('refresh').disabled = false; }); });
    load();
  </script>
</body>
</html>`;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// 대시보드 HTML
		if (path === '/' || path === '/index.html') {
			return new Response(dashboardHTML(), {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}

		// API: KRW 마켓 목록
		if (path === '/api/markets') {
			try {
				const list = await fetchKRWMarkets();
				return Response.json(list, {
					headers: { 'Cache-Control': 'public, max-age=300' },
				});
			} catch (e) {
				return Response.json({ error: String(e) }, { status: 502 });
			}
		}

		// API: 대시보드용 거래량·RSI 집계 (서버에서 Upbit 호출 후 정렬용 데이터 반환)
		// Worker CPU/실행 시간 한도 때문에 마켓 수 제한 (limit 파라미터, 기본 50)
		if (path === '/api/dashboard') {
			const unit = Math.min(240, Math.max(1, parseInt(url.searchParams.get('unit') || '15', 10) || 15));
			const count = Math.min(200, Math.max(14, parseInt(url.searchParams.get('count') || '30', 10) || 30));
			const limit = Math.min(100, Math.max(10, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
			const allowedUnits = [1, 3, 5, 10, 15, 30, 60, 240];
			const safeUnit = allowedUnits.includes(unit) ? unit : 15;

			try {
				const allMarkets = await fetchKRWMarkets();
				const markets = allMarkets.slice(0, limit);
				const rows: DashboardRow[] = await runBatched(
					markets,
					5,
					async (m) => {
						const candles = await fetchCandles(safeUnit, m.market, count);
						if (candles.length === 0) {
							return {
								market: m.market,
								korean_name: m.korean_name,
								trade_price: 0,
								volume: 0,
								volumePrice: 0,
								rsi: null,
							};
						}
						const closes = candles.map((c) => c.trade_price).reverse();
						const volumeSum = candles.reduce((s, c) => s + c.candle_acc_trade_volume, 0);
						const volumePriceSum = candles.reduce((s, c) => s + c.candle_acc_trade_price, 0);
						const last = candles[0]!;
						return {
							market: m.market,
							korean_name: m.korean_name,
							trade_price: last.trade_price,
							volume: volumeSum,
							volumePrice: volumePriceSum,
							rsi: calcRSI(closes, RSI_PERIOD),
						};
					},
				);
				return Response.json(
					{ rows, totalMarkets: allMarkets.length, limit },
					{ headers: { 'Cache-Control': 'no-store' } },
				);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				return Response.json({ error: message }, { status: 502, headers: { 'Content-Type': 'application/json' } });
			}
		}

		// favicon 등 404 방지
		if (path === '/favicon.ico') {
			return new Response(null, { status: 204 });
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
