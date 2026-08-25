/**
 * SUNWIN TÀI XỈU PREDICTOR v5
 * Node.js 18+ (không cần package ngoài)
 *
 * Chạy:
 *   node sunwin.js
 *
 * Mở:
 *   http://localhost:3000/predict
 *   http://localhost:3000/health
 *
 * Lưu ý:
 * - Dự đoán thống kê từ lịch sử, không thể đảm bảo kết quả tương lai.
 * - Không dùng Math.random().
 */

const http = require("http");

const PORT = Number(process.env.PORT || 3000);
const HISTORY_URL =
  process.env.HISTORY_URL ||
  "https://kwinstore.com/sunwin/tx/history/205f322f9e1f536c68e8d80ba746533bf96072e975298c17";

const FETCH_TIMEOUT_MS = 10000;
const MAX_HISTORY = 1000;
const MIN_BACKTEST = 80;

function normalizeResult(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s.includes("tài") || s === "tai" || s === "t") return "TÀI";
  if (s.includes("xỉu") || s === "xiu" || s === "x") return "XỈU";
  return null;
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeRow(row) {
  const phien =
    asNumber(row["phiên"]) ??
    asNumber(row.phien) ??
    asNumber(row.session) ??
    asNumber(row.id);

  const d1 = asNumber(row.d1 ?? row.xuc_xac_1 ?? row.dice1);
  const d2 = asNumber(row.d2 ?? row.xuc_xac_2 ?? row.dice2);
  const d3 = asNumber(row.d3 ?? row.xuc_xac_3 ?? row.dice3);
  const tong = asNumber(row["tổng"] ?? row.tong ?? row.total) ?? (
    d1 != null && d2 != null && d3 != null ? d1 + d2 + d3 : null
  );
  const ketQua = normalizeResult(row["kết quả"] ?? row.ket_qua ?? row.result);

  if (phien == null || ketQua == null) return null;

  return {
    phien,
    d1,
    d2,
    d3,
    tong,
    ketQua,
    updatedAt: row.updatedAt ?? row.updated_at ?? null
  };
}

async function fetchJson(url, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/json,text/plain,*/*",
        "user-agent": "SUNWIN-Predictor/1.0"
      },
      cache: "no-store"
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadHistory() {
  const json = await fetchJson(HISTORY_URL);

  const raw =
    Array.isArray(json) ? json :
    Array.isArray(json.data) ? json.data :
    Array.isArray(json.history) ? json.history :
    [];

  const seen = new Set();
  const rows = [];

  for (const item of raw) {
    const r = normalizeRow(item);
    if (!r) continue;
    if (seen.has(r.phien)) continue;
    seen.add(r.phien);
    rows.push(r);
  }

  // Cũ -> mới để thuật toán chạy đúng thứ tự thời gian.
  rows.sort((a, b) => a.phien - b.phien);

  return rows.slice(-MAX_HISTORY);
}

function signLabel(v) {
  return v >= 0 ? "TÀI" : "XỈU";
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(avg(arr.map(x => (x - m) ** 2)));
}

function resultNum(r) {
  return r.ketQua === "TÀI" ? 1 : -1;
}

function lastN(history, n) {
  return history.slice(-Math.min(n, history.length));
}

/**
 * MODEL 1: Markov bậc 1.
 * Dựa vào xác suất kết quả sau trạng thái cuối cùng.
 */
function modelMarkov1(history) {
  if (history.length < 10) return 0;
  const last = history[history.length - 1].ketQua;

  let tai = 0, xiu = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i - 1].ketQua !== last) continue;
    if (history[i].ketQua === "TÀI") tai++;
    else xiu++;
  }

  const total = tai + xiu;
  if (!total) return 0;
  return (tai - xiu) / total;
}

/**
 * MODEL 2: Markov bậc 2.
 */
function modelMarkov2(history) {
  if (history.length < 14) return 0;

  const a = history.at(-2).ketQua;
  const b = history.at(-1).ketQua;
  let tai = 0, xiu = 0;

  for (let i = 2; i < history.length; i++) {
    if (
      history[i - 2].ketQua === a &&
      history[i - 1].ketQua === b
    ) {
      if (history[i].ketQua === "TÀI") tai++;
      else xiu++;
    }
  }

  const total = tai + xiu;
  if (!total) return 0;
  return (tai - xiu) / total;
}

/**
 * MODEL 3: Pattern khớp chuỗi 3..8 ván gần nhất.
 * Pattern dài hơn được ưu tiên.
 */
function modelPattern(history) {
  if (history.length < 20) return 0;

  let score = 0;
  let weight = 0;

  for (let len = 3; len <= 8; len++) {
    if (history.length <= len + 2) continue;

    const tail = history.slice(-len).map(x => x.ketQua).join(",");
    let tai = 0, xiu = 0;

    for (let i = 0; i + len < history.length; i++) {
      const seq = history.slice(i, i + len).map(x => x.ketQua).join(",");
      if (seq !== tail) continue;

      if (history[i + len].ketQua === "TÀI") tai++;
      else xiu++;
    }

    const total = tai + xiu;
    if (!total) continue;

    const w = len * Math.sqrt(total);
    score += ((tai - xiu) / total) * w;
    weight += w;
  }

  return weight ? score / weight : 0;
}

/**
 * MODEL 4: Streak transition.
 * Học từ các chuỗi bệt có cùng độ dài gần nhất.
 */
function modelStreak(history) {
  if (history.length < 20) return 0;

  const lastRes = history.at(-1).ketQua;
  let streak = 1;

  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].ketQua === lastRes) streak++;
    else break;
  }

  streak = Math.min(streak, 8);
  let same = 0, flip = 0;

  for (let i = 1; i < history.length - 1; i++) {
    let s = 1;
    for (let j = i - 1; j >= 0 && history[j].ketQua === history[i].ketQua; j--) {
      s++;
      if (s >= streak) break;
    }

    if (s !== streak) continue;

    const next = history[i + 1].ketQua;
    if (next === history[i].ketQua) same++;
    else flip++;
  }

  const total = same + flip;
  if (!total) return 0;

  const continuation = (same - flip) / total;
  return lastRes === "TÀI" ? continuation : -continuation;
}

/**
 * MODEL 5: Rolling imbalance.
 * Không đơn giản lấy đa số; đo lệch giữa cửa sổ ngắn và dài.
 */
function modelRollingBalance(history) {
  if (history.length < 30) return 0;

  const s8 = avg(lastN(history, 8).map(resultNum));
  const s20 = avg(lastN(history, 20).map(resultNum));
  const s50 = avg(lastN(history, 50).map(resultNum));

  // Nếu ngắn hạn lệch mạnh so với nền dài, cho xu hướng hồi nhẹ.
  return clamp((s20 * 0.45 + s50 * 0.20) - (s8 - s20) * 0.55, -1, 1);
}

/**
 * MODEL 6: Tổng xúc xắc.
 * Học chuyển trạng thái theo vùng tổng của phiên trước.
 */
function sumBand(total) {
  if (total == null) return "NA";
  if (total <= 6) return "LOW";
  if (total <= 10) return "MID_LOW";
  if (total <= 13) return "MID_HIGH";
  return "HIGH";
}

function modelSumTransition(history) {
  const usable = history.filter(x => x.tong != null);
  if (usable.length < 30) return 0;

  const band = sumBand(usable.at(-1).tong);
  let tai = 0, xiu = 0;

  for (let i = 1; i < usable.length; i++) {
    if (sumBand(usable[i - 1].tong) !== band) continue;
    if (usable[i].ketQua === "TÀI") tai++;
    else xiu++;
  }

  const total = tai + xiu;
  return total ? (tai - xiu) / total : 0;
}

/**
 * MODEL 7: Delta tổng.
 * Học hướng kết quả sau khi tổng tăng/giảm/đứng tương tự.
 */
function deltaBucket(v) {
  if (v <= -4) return "DOWN_BIG";
  if (v < 0) return "DOWN";
  if (v === 0) return "FLAT";
  if (v >= 4) return "UP_BIG";
  return "UP";
}

function modelSumDelta(history) {
  const usable = history.filter(x => x.tong != null);
  if (usable.length < 35) return 0;

  const currentDelta = usable.at(-1).tong - usable.at(-2).tong;
  const bucket = deltaBucket(currentDelta);

  let tai = 0, xiu = 0;
  for (let i = 2; i < usable.length; i++) {
    const d = usable[i - 1].tong - usable[i - 2].tong;
    if (deltaBucket(d) !== bucket) continue;

    if (usable[i].ketQua === "TÀI") tai++;
    else xiu++;
  }

  const total = tai + xiu;
  return total ? (tai - xiu) / total : 0;
}

/**
 * MODEL 8: Dice signature.
 * Dùng parity + số mặt cao (>=4) của phiên trước.
 */
function diceSignature(r) {
  if ([r.d1, r.d2, r.d3].some(v => v == null)) return null;
  const odd = [r.d1, r.d2, r.d3].filter(v => v % 2 === 1).length;
  const high = [r.d1, r.d2, r.d3].filter(v => v >= 4).length;
  return `${odd}O-${high}H`;
}

function modelDiceSignature(history) {
  const sig = diceSignature(history.at(-1));
  if (!sig || history.length < 30) return 0;

  let tai = 0, xiu = 0;
  for (let i = 1; i < history.length; i++) {
    if (diceSignature(history[i - 1]) !== sig) continue;

    if (history[i].ketQua === "TÀI") tai++;
    else xiu++;
  }

  const total = tai + xiu;
  return total ? (tai - xiu) / total : 0;
}

/**
 * MODEL 9: Z-score tổng gần đây.
 * Tổng quá cao/thấp so với nền được dùng như tín hiệu hồi quy nhẹ.
 */
function modelSumZscore(history) {
  const totals = history.filter(x => x.tong != null).map(x => x.tong);
  if (totals.length < 40) return 0;

  const base = totals.slice(-80);
  const recent = totals.slice(-5);
  const m = avg(base);
  const sd = std(base) || 1;
  const z = (avg(recent) - m) / sd;

  return clamp(-z / 2.5, -1, 1);
}

/**
 * MODEL 10: Entropy-like alternation.
 * Đánh giá mức đổi cửa trong 12/30 ván.
 */
function alternationRate(rows) {
  if (rows.length < 2) return 0.5;
  let changes = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].ketQua !== rows[i - 1].ketQua) changes++;
  }
  return changes / (rows.length - 1);
}

function modelAlternation(history) {
  if (history.length < 35) return 0;

  const r12 = alternationRate(lastN(history, 12));
  const r30 = alternationRate(lastN(history, 30));
  const last = history.at(-1).ketQua;

  // Rate > 0.5: thiên đổi cửa, < 0.5: thiên giữ cửa.
  const tendency = clamp(((r12 * 0.7 + r30 * 0.3) - 0.5) * 2, -1, 1);
  const lastSign = last === "TÀI" ? 1 : -1;

  return -lastSign * tendency;
}



/**
 * DICE CONTEXT HELPERS
 * Các model dưới đây chỉ phát tín hiệu khi đúng "tình huống" xúc xắc hiện tại.
 */
function diceValues(r) {
  if (!r || [r.d1, r.d2, r.d3].some(v => v == null)) return null;
  return [r.d1, r.d2, r.d3];
}

function sortedDice(r) {
  const d = diceValues(r);
  return d ? [...d].sort((a, b) => a - b) : null;
}

function diceKind(r) {
  const d = diceValues(r);
  if (!d) return "NA";
  const uniq = new Set(d).size;
  if (uniq === 1) return "TRIPLE";
  if (uniq === 2) return "PAIR";
  return "ALL_DIFF";
}

function diceSpread(r) {
  const d = diceValues(r);
  if (!d) return null;
  return Math.max(...d) - Math.min(...d);
}

function diceShape(r) {
  const d = sortedDice(r);
  if (!d) return null;

  const odd = d.filter(v => v % 2).length;
  const high = d.filter(v => v >= 4).length;
  const kind = diceKind(r);
  const spread = d[2] - d[0];

  return `${kind}|O${odd}|H${high}|S${Math.min(spread, 4)}`;
}

function scoreNextByContext(history, contextFn, currentContext, minSamples = 4) {
  if (currentContext == null) return 0;

  let tai = 0, xiu = 0;
  for (let i = 1; i < history.length; i++) {
    if (contextFn(history[i - 1]) !== currentContext) continue;
    if (history[i].ketQua === "TÀI") tai++;
    else xiu++;
  }

  const n = tai + xiu;
  if (n < minSamples) return 0;

  // smoothing để tránh vài mẫu làm tín hiệu quá mạnh
  const pTai = (tai + 1.5) / (n + 3);
  return clamp((pTai - (1 - pTai)) * Math.min(1, n / 16), -1, 1);
}

/**
 * MODEL 11: Xúc xắc đôi / bộ ba / ba mặt khác nhau.
 */
function modelDiceKind(history) {
  if (history.length < 35) return 0;
  const current = diceKind(history.at(-1));
  return scoreNextByContext(history, diceKind, current, current === "TRIPLE" ? 2 : 5);
}

/**
 * MODEL 12: Dạng xúc xắc tổng hợp.
 * Ghép loại đôi/bộ ba + số lẻ + số mặt cao + độ giãn.
 */
function modelDiceShape(history) {
  if (history.length < 45) return 0;
  const current = diceShape(history.at(-1));
  return scoreNextByContext(history, diceShape, current, 4);
}

/**
 * MODEL 13: Bộ xúc xắc đã sắp xếp.
 * Ví dụ 2-4-6 và 6-2-4 được xem cùng một dạng.
 */
function modelDiceSortedTuple(history) {
  if (history.length < 55) return 0;

  const keyFn = r => {
    const d = sortedDice(r);
    return d ? d.join("-") : null;
  };

  const key = keyFn(history.at(-1));
  return scoreNextByContext(history, keyFn, key, 3);
}

/**
 * MODEL 14: Chẵn/lẻ + chẵn/lẻ của tổng.
 */
function modelDiceParityCase(history) {
  if (history.length < 40) return 0;

  const keyFn = r => {
    const d = diceValues(r);
    if (!d || r.tong == null) return null;
    const odd = d.filter(v => v % 2).length;
    return `${odd}ODD|SUM${r.tong % 2 ? "ODD" : "EVEN"}`;
  };

  return scoreNextByContext(history, keyFn, keyFn(history.at(-1)), 5);
}

/**
 * MODEL 15: Phân bố cao/thấp.
 * Mặt 1-3 = thấp, 4-6 = cao.
 */
function modelDiceHighLowCase(history) {
  if (history.length < 40) return 0;

  const keyFn = r => {
    const d = diceValues(r);
    if (!d) return null;
    const high = d.filter(v => v >= 4).length;
    const low = 3 - high;
    return `${high}H-${low}L`;
  };

  return scoreNextByContext(history, keyFn, keyFn(history.at(-1)), 5);
}

/**
 * MODEL 16: Tổng sát ngưỡng 10/11.
 * Chỉ hoạt động rõ khi tổng trước nằm 8..13.
 */
function modelDiceThresholdCase(history) {
  if (history.length < 45) return 0;
  const last = history.at(-1);
  if (last.tong == null || last.tong < 8 || last.tong > 13) return 0;

  const keyFn = r => {
    if (r.tong == null || r.tong < 8 || r.tong > 13) return null;
    if (r.tong <= 9) return "LOW_NEAR";
    if (r.tong === 10) return "TEN";
    if (r.tong === 11) return "ELEVEN";
    if (r.tong <= 13) return "HIGH_NEAR";
    return null;
  };

  return scoreNextByContext(history, keyFn, keyFn(last), 4);
}

/**
 * MODEL 17: Biến động vector xúc xắc đã sắp xếp.
 * So sánh từng vị trí của bộ đã sort giữa 2 phiên liên tiếp.
 */
function modelDiceVectorDelta(history) {
  if (history.length < 55) return 0;

  const deltaKeyAt = (rows, idx) => {
    if (idx < 1) return null;
    const a = sortedDice(rows[idx - 1]);
    const b = sortedDice(rows[idx]);
    if (!a || !b) return null;

    const enc = (x) => x > 0 ? "U" : x < 0 ? "D" : "F";
    return [enc(b[0] - a[0]), enc(b[1] - a[1]), enc(b[2] - a[2])].join("");
  };

  const current = deltaKeyAt(history, history.length - 1);
  if (!current) return 0;

  let tai = 0, xiu = 0;
  for (let i = 2; i < history.length; i++) {
    if (deltaKeyAt(history, i - 1) !== current) continue;
    if (history[i].ketQua === "TÀI") tai++;
    else xiu++;
  }

  const n = tai + xiu;
  if (n < 4) return 0;
  const pTai = (tai + 1.5) / (n + 3);
  return clamp((pTai - (1 - pTai)) * Math.min(1, n / 14), -1, 1);
}

/**
 * MODEL 18: Độ giãn xúc xắc.
 * Tách bộ sít / trung bình / giãn mạnh rồi học trạng thái kế tiếp.
 */
function modelDiceSpreadCase(history) {
  if (history.length < 40) return 0;

  const keyFn = r => {
    const s = diceSpread(r);
    if (s == null) return null;
    if (s <= 1) return "TIGHT";
    if (s <= 3) return "MID";
    return "WIDE";
  };

  return scoreNextByContext(history, keyFn, keyFn(history.at(-1)), 5);
}

/**
 * Trọng số theo tình huống xúc xắc hiện tại.
 * Model không đúng ngữ cảnh sẽ không được boost.
 */
function diceContextMultiplier(modelName, history) {
  const last = history.at(-1);
  if (!last) return 1;

  const kind = diceKind(last);
  const spread = diceSpread(last);
  const total = last.tong;

  switch (modelName) {
    case "Dice-Kind":
      return kind === "TRIPLE" ? 1.55 : kind === "PAIR" ? 1.30 : 1.00;

    case "Dice-Shape":
      return 1.18;

    case "Dice-SortedTuple":
      return kind !== "ALL_DIFF" ? 1.18 : 1.08;

    case "Dice-Parity-Case":
      return 1.12;

    case "Dice-HighLow-Case":
      return 1.12;

    case "Dice-Threshold":
      return total != null && total >= 8 && total <= 13 ? 1.40 : 0.70;

    case "Dice-Vector-Delta":
      return history.length >= 2 ? 1.12 : 0.80;

    case "Dice-Spread":
      return spread != null && (spread <= 1 || spread >= 4) ? 1.28 : 1.00;

    case "Dice-Signature":
      return 1.08;

    default:
      return 1.00;
  }
}

/**
 * MODEL 11: Cầu bệt động.
 * Học xác suất nối tiếp/bẻ sau đúng độ dài bệt hiện tại.
 */
function modelCauBet(history) {
  if (history.length < 30) return 0;

  const last = history.at(-1).ketQua;
  let streak = 1;
  for (let i = history.length - 2; i >= 0 && history[i].ketQua === last; i--) streak++;
  streak = Math.min(streak, 7);

  let follow = 0, breakCau = 0;
  for (let i = streak - 1; i < history.length - 1; i++) {
    const side = history[i].ketQua;
    let run = 1;
    for (let j = i - 1; j >= 0 && history[j].ketQua === side; j--) run++;
    if (Math.min(run, 7) !== streak) continue;

    if (history[i + 1].ketQua === side) follow++;
    else breakCau++;
  }

  const n = follow + breakCau;
  if (n < 4) return 0;

  const continuation = (follow - breakCau) / n;
  return last === "TÀI" ? continuation : -continuation;
}

/**
 * MODEL 12: Cầu 1-1.
 * Khi chuỗi gần đây đổi cửa liên tục, ưu tiên phía đối diện phiên cuối.
 */
function modelCau11(history) {
  if (history.length < 16) return 0;

  const recent = lastN(history, 10);
  const alt = alternationRate(recent);
  if (alt < 0.68) return 0;

  const last = history.at(-1).ketQua;
  const oppositeSign = last === "TÀI" ? -1 : 1;
  return clamp(oppositeSign * ((alt - 0.5) * 1.8), -1, 1);
}

function getRuns(history, limit = 20) {
  if (!history.length) return [];
  const rows = history.slice(-Math.max(2, limit * 5));
  const runs = [];
  let side = rows[0].ketQua;
  let len = 1;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i].ketQua === side) {
      len++;
    } else {
      runs.push({ side, len });
      side = rows[i].ketQua;
      len = 1;
    }
  }
  runs.push({ side, len });
  return runs.slice(-limit);
}

function modelFixedRun(history, target) {
  if (history.length < 25) return 0;

  const runs = getRuns(history, 14);
  if (runs.length < 4) return 0;

  const recentCompleted = runs.slice(0, -1).slice(-6);
  const closeness = recentCompleted.length
    ? recentCompleted.filter(r => r.len === target).length / recentCompleted.length
    : 0;

  if (closeness < 0.34) return 0;

  const current = runs.at(-1);
  const sideSign = current.side === "TÀI" ? 1 : -1;

  // Chưa đủ nhịp target => thiên nối; đủ/qua target => thiên bẻ.
  if (current.len < target) return sideSign * clamp(0.30 + closeness * 0.55, 0, 0.9);
  return -sideSign * clamp(0.25 + closeness * 0.60, 0, 0.9);
}

/** MODEL 13: Cầu 2-2 */
function modelCau22(history) {
  return modelFixedRun(history, 2);
}

/** MODEL 14: Cầu 3-3 */
function modelCau33(history) {
  return modelFixedRun(history, 3);
}

/**
 * MODEL 15: Cầu nhịp tự học.
 * Học độ dài run phổ biến trong 8 run hoàn tất gần nhất.
 */
function modelCauNhip(history) {
  if (history.length < 35) return 0;

  const runs = getRuns(history, 12);
  if (runs.length < 5) return 0;

  const completed = runs.slice(0, -1).slice(-8);
  const freq = new Map();
  for (const r of completed) {
    const k = Math.min(r.len, 5);
    freq.set(k, (freq.get(k) || 0) + 1);
  }

  let bestLen = 1, bestCount = 0;
  for (const [len, count] of freq.entries()) {
    if (count > bestCount) {
      bestLen = len;
      bestCount = count;
    }
  }

  const dominance = bestCount / completed.length;
  if (dominance < 0.30) return 0;

  const current = runs.at(-1);
  const sign = current.side === "TÀI" ? 1 : -1;

  if (current.len < bestLen) return sign * clamp(0.20 + dominance * 0.60, 0, 0.85);
  return -sign * clamp(0.18 + dominance * 0.58, 0, 0.82);
}

/**
 * MODEL 16: Cầu gãy/hồi.
 * Nếu một nhịp ổn định vừa bị phá, xem lịch sử các lần gãy tương tự để học phiên kế.
 */
function modelCauBreakRecovery(history) {
  if (history.length < 50) return 0;

  const runs = getRuns(history, 16);
  if (runs.length < 6) return 0;

  const completed = runs.slice(0, -1);
  const baseline = completed.slice(-5, -1);
  if (baseline.length < 3) return 0;

  const lens = baseline.map(r => Math.min(r.len, 5));
  const mode = lens.sort((a, b) =>
    lens.filter(v => v === a).length - lens.filter(v => v === b).length
  ).at(-1);

  const prev = completed.at(-1);
  const current = runs.at(-1);
  if (!mode || prev.len === mode) return 0;

  // Sau khi run trước lệch khỏi nhịp mode, dùng trạng thái hiện tại để hồi về nhịp cũ.
  const sign = current.side === "TÀI" ? 1 : -1;
  if (current.len < mode) return sign * 0.42;
  return -sign * 0.42;
}

function identifyCau(history) {
  const runs = getRuns(history, 12);
  if (!runs.length) return "Chưa xác định";

  const cur = runs.at(-1);
  const completed = runs.slice(0, -1).slice(-6);
  const alt = alternationRate(lastN(history, 10));

  if (cur.len >= 4) return `Cầu bệt ${cur.side} ${cur.len}`;
  if (alt >= 0.82) return "Cầu 1-1";

  for (const n of [2, 3]) {
    if (completed.length >= 4) {
      const match = completed.filter(r => r.len === n).length / completed.length;
      if (match >= 0.50) return `Cầu ${n}-${n}`;
    }
  }

  if (completed.length >= 4) {
    const lens = completed.map(r => r.len).join("-");
    return `Cầu nhịp ${lens}`;
  }

  return "Cầu hỗn hợp";
}


/**
 * MODEL 17: Cầu cây (Context Tree).
 * Xây cây ngữ cảnh từ chuỗi T/X lịch sử:
 * - Nhánh sâu 1 -> 7 phiên.
 * - Mỗi nhánh lưu số lần phiên kế tiếp ra TÀI/XỈU.
 * - Nhánh dài hơn được ưu tiên nhưng có co trọng số khi mẫu ít.
 */
function modelCauCay(history) {
  if (history.length < 35) return 0;

  const seq = history.map(r => r.ketQua === "TÀI" ? "T" : "X");
  const maxDepth = 7;
  let weightedScore = 0;
  let totalWeight = 0;

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (seq.length <= depth + 2) continue;

    const context = seq.slice(-depth).join("");
    let tai = 0;
    let xiu = 0;

    for (let i = depth; i < seq.length; i++) {
      const prev = seq.slice(i - depth, i).join("");
      if (prev !== context) continue;

      if (seq[i] === "T") tai++;
      else xiu++;
    }

    const samples = tai + xiu;
    if (!samples) continue;

    // Laplace smoothing để tránh 1-2 mẫu làm lệch mạnh.
    const pTai = (tai + 1.5) / (samples + 3);
    const pXiu = 1 - pTai;
    const edge = pTai - pXiu;

    // Nhánh sâu quan trọng hơn, nhưng mẫu ít sẽ bị giảm trọng số.
    const sampleFactor = Math.min(1, samples / 12);
    const depthFactor = 0.55 + depth * 0.13;
    const w = sampleFactor * depthFactor;

    weightedScore += edge * w;
    totalWeight += w;
  }

  return totalWeight ? clamp(weightedScore / totalWeight, -1, 1) : 0;
}

/**
 * Mô tả nhánh cầu cây hiện tại để trả ra API.
 */
function describeCauCay(history) {
  if (history.length < 8) {
    return {
      nhanh: null,
      do_sau: 0,
      mau: 0,
      tai: 0,
      xiu: 0,
      uu_tien: "CHƯA ĐỦ DỮ LIỆU"
    };
  }

  const seq = history.map(r => r.ketQua === "TÀI" ? "T" : "X");

  for (let depth = Math.min(7, seq.length - 1); depth >= 1; depth--) {
    const context = seq.slice(-depth).join("");
    let tai = 0;
    let xiu = 0;

    for (let i = depth; i < seq.length; i++) {
      const prev = seq.slice(i - depth, i).join("");
      if (prev !== context) continue;

      if (seq[i] === "T") tai++;
      else xiu++;
    }

    const samples = tai + xiu;
    if (samples >= 3) {
      return {
        nhanh: context,
        do_sau: depth,
        mau: samples,
        tai,
        xiu,
        uu_tien: tai === xiu ? "CÂN BẰNG" : (tai > xiu ? "TÀI" : "XỈU")
      };
    }
  }

  return {
    nhanh: seq.slice(-3).join(""),
    do_sau: Math.min(3, seq.length),
    mau: 0,
    tai: 0,
    xiu: 0,
    uu_tien: "CHƯA CÓ NHÁNH ĐỦ MẪU"
  };
}

const MODELS = [
  ["Markov-1", modelMarkov1],
  ["Markov-2", modelMarkov2],
  ["Pattern-3..8", modelPattern],
  ["Streak", modelStreak],
  ["Rolling-Balance", modelRollingBalance],
  ["Sum-Transition", modelSumTransition],
  ["Sum-Delta", modelSumDelta],
  ["Dice-Signature", modelDiceSignature],
  ["Dice-Kind", modelDiceKind],
  ["Dice-Shape", modelDiceShape],
  ["Dice-SortedTuple", modelDiceSortedTuple],
  ["Dice-Parity-Case", modelDiceParityCase],
  ["Dice-HighLow-Case", modelDiceHighLowCase],
  ["Dice-Threshold", modelDiceThresholdCase],
  ["Dice-Vector-Delta", modelDiceVectorDelta],
  ["Dice-Spread", modelDiceSpreadCase],
  ["Sum-ZScore", modelSumZscore],
  ["Alternation", modelAlternation],
  ["Cau-Bet", modelCauBet],
  ["Cau-1-1", modelCau11],
  ["Cau-2-2", modelCau22],
  ["Cau-3-3", modelCau33],
  ["Cau-Nhip", modelCauNhip],
  ["Cau-Gay-Hoi", modelCauBreakRecovery],
  ["Cau-Cay", modelCauCay]
];

/**
 * Backtest từng model trên phần lịch sử quá khứ.
 * Chỉ dùng dữ liệu đứng trước điểm test => tránh nhìn trước tương lai.
 */
function backtestModel(history, fn) {
  if (history.length < MIN_BACKTEST) {
    return {
      accuracy: 0.5,
      recentAccuracy: 0.5,
      midAccuracy: 0.5,
      samples: 0,
      recentSamples: 0,
      weight: 0.25,
      invert: false,
      adjustment: "GIỮ"
    };
  }

  const start = Math.max(40, history.length - 420);
  const records = [];

  for (let i = start; i < history.length; i++) {
    const past = history.slice(0, i);
    let score = fn(past);
    if (!Number.isFinite(score) || Math.abs(score) < 0.05) continue;

    score = clamp(score, -1, 1);
    const pred = signLabel(score);

    records.push({
      index: i,
      hit: pred === history[i].ketQua ? 1 : 0,
      strength: Math.abs(score)
    });
  }

  if (records.length < 12) {
    const accuracy = records.length ? avg(records.map(x => x.hit)) : 0.5;
    return {
      accuracy,
      recentAccuracy: accuracy,
      midAccuracy: accuracy,
      samples: records.length,
      recentSamples: records.length,
      weight: 0.25,
      invert: false,
      adjustment: "GIỮ"
    };
  }

  const accuracy = avg(records.map(x => x.hit));
  const recent = records.slice(-30);
  const mid = records.slice(-90);

  const recentAccuracy = avg(recent.map(x => x.hit));
  const midAccuracy = avg(mid.map(x => x.hit));

  // Co các accuracy về 50% khi mẫu chưa đủ lớn.
  const longShrink = Math.min(1, records.length / 140);
  const recentShrink = Math.min(1, recent.length / 30);
  const midShrink = Math.min(1, mid.length / 70);

  const adjLong = 0.5 + (accuracy - 0.5) * longShrink;
  const adjRecent = 0.5 + (recentAccuracy - 0.5) * recentShrink;
  const adjMid = 0.5 + (midAccuracy - 0.5) * midShrink;

  // Điểm phong độ: gần đây quan trọng nhất nhưng vẫn bị neo bởi nền dài.
  const formScore = adjRecent * 0.58 + adjMid * 0.27 + adjLong * 0.15;
  const momentum = adjRecent - adjMid;

  // Nếu model có hiệu suất ổn định dưới 50%, đảo tín hiệu của nó.
  const invert = (
    records.length >= 35 &&
    recent.length >= 20 &&
    formScore < 0.475 &&
    adjLong < 0.495
  );

  const usableForm = invert ? (1 - formScore) : formScore;
  const usableMomentum = invert ? -momentum : momentum;

  // Trọng số động: 0.18 -> 2.60.
  // Tăng mạnh khi recent > nền, giảm khi recent tụt.
  let weight =
    0.62 +
    (usableForm - 0.5) * 9.2 +
    usableMomentum * 4.6;

  const avgStrength = avg(records.slice(-40).map(x => x.strength));
  weight *= 0.72 + avgStrength * 0.55;
  weight = clamp(weight, 0.15, 2.85);

  const baseline = 0.62 + Math.max(0, (Math.abs(adjLong - 0.5) * 4));
  let adjustment = "GIỮ";
  if (weight > baseline * 1.18) adjustment = "TĂNG";
  else if (weight < baseline * 0.82) adjustment = "GIẢM";

  return {
    accuracy,
    recentAccuracy,
    midAccuracy,
    adjusted: formScore,
    samples: records.length,
    recentSamples: recent.length,
    weight,
    invert,
    adjustment,
    momentum
  };
}

function predict(history) {
  if (!Array.isArray(history) || history.length < 20) {
    throw new Error("Không đủ lịch sử hợp lệ để dự đoán.");
  }

  const details = [];
  let weighted = 0;
  let totalWeight = 0;

  for (const [name, fn] of MODELS) {
    let raw = fn(history);
    if (!Number.isFinite(raw)) raw = 0;
    raw = clamp(raw, -1, 1);

    const bt = backtestModel(history, fn);
    const effective = bt.invert ? -raw : raw;

    const activity = 0.35 + Math.min(0.65, Math.abs(effective));
    const contextMultiplier = diceContextMultiplier(name, history);
    const w = bt.weight * activity * contextMultiplier;

    weighted += effective * w;
    totalWeight += w;

    details.push({
      mo_hinh: name,
      tin_hieu: Number(effective.toFixed(4)),
      du_doan: Math.abs(effective) < 0.03 ? "TRUNG TÍNH" : signLabel(effective),
      backtest_tong: `${(bt.accuracy * 100).toFixed(1)}%`,
      backtest_gan: `${(bt.recentAccuracy * 100).toFixed(1)}%`,
      backtest_trung: `${(bt.midAccuracy * 100).toFixed(1)}%`,
      mau_test: bt.samples,
      dao_chieu: Boolean(bt.invert),
      dieu_chinh_trong_so: bt.adjustment,
      trong_so_dong: Number(w.toFixed(4))
    });
  }

  let ensemble = totalWeight ? weighted / totalWeight : 0;

  // Tie-break hoàn toàn xác định, không random.
  if (Math.abs(ensemble) < 0.015) {
    const tie =
      modelMarkov2(history) * 0.25 +
      modelPattern(history) * 0.25 +
      modelCauNhip(history) * 0.17 +
      modelCauBet(history) * 0.13 +
      modelCauCay(history) * 0.20 +
      modelSumTransition(history) * 0.10;

    ensemble = tie || (history.at(-1).tong >= 11 ? -0.02 : 0.02);
  }

  const duDoan = signLabel(ensemble);

  // Confidence chỉ biểu diễn sức đồng thuận mô hình, không phải xác suất thắng thật.
  const activeDetails = details.filter(x => x.du_doan !== "TRUNG TÍNH");
  const agreement = activeDetails.length
    ? details.filter(x => x.du_doan === duDoan).length / activeDetails.length
    : 0.5;

  const strength = Math.min(1, Math.abs(ensemble));
  const confidence = clamp(50 + strength * 22 + agreement * 8, 50, 78);

  const newest = history.at(-1);
  const recent = lastN(history, 20);
  const tai20 = recent.filter(x => x.ketQua === "TÀI").length;
  const xiu20 = recent.length - tai20;

  return {
    phien: newest.phien,
    xuc_xac_1: newest.d1,
    xuc_xac_2: newest.d2,
    xuc_xac_3: newest.d3,
    tong: newest.tong,
    ket_qua: newest.ketQua === "TÀI" ? "Tài" : "Xỉu",
    phien_hien_tai: newest.phien + 1,
    du_doan: duDoan === "TÀI" ? "Tài" : "Xỉu",
    do_tin_cay: `${Math.round(confidence)}%`
  };
}

let cache = {
  time: 0,
  result: null,
  lastSession: null
};

async function getPrediction() {
  // Cache ngắn để tránh spam nguồn.
  if (cache.result && Date.now() - cache.time < 2500) {
    return cache.result;
  }

  const history = await loadHistory();
  if (!history.length) throw new Error("API history không có dữ liệu hợp lệ.");

  const result = predict(history);

  cache = {
    time: Date.now(),
    result,
    lastSession: result.phien
  };

  return result;
}

function sendJson(res, statusCode, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    return res.end();
  }

  if (req.method !== "GET") {
    return sendJson(res, 405, {
      status: "error",
      message: "Method not allowed"
    });
  }

  if (url.pathname === "/" || url.pathname === "/health") {
    return sendJson(res, 200, {
      status: "ok",
      service: "SUNWIN Tài Xỉu Predictor",
      endpoint: "/taixiu",
      history_url: HISTORY_URL
    });
  }

  if (
    url.pathname === "/taixiu" ||
    url.pathname === "/predict" ||
    url.pathname === "/api/taixiu/sunwin"
  ) {
    try {
      const result = await getPrediction();
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, {
        status: "error",
        message: err?.message || String(err)
      });
    }
  }

  return sendJson(res, 404, {
    status: "error",
    message: "Not found",
    endpoints: ["/taixiu", "/health"]
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`SUNWIN Predictor running: http://localhost:${PORT}/taixiu`);
});
