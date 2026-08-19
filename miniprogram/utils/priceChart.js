// utils/priceChart.js 价格波动折线图（Canvas 2D）
const { fmtDate } = require("./format");

const COLORS = {
  sell: "#fa5151",
  cost: "#4a7dff",
};

// seriesList: [{ type:'sell'|'cost', label, points:[{t,v}] }]
function drawPriceChart(ctx, W, H, seriesList) {
  const PAD_L = 46;
  const PAD_R = 16;
  const PAD_T = 30;
  const PAD_B = 34;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  // 白底
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // 收集所有点，求范围
  const allV = [];
  let minT = Infinity;
  let maxT = -Infinity;
  seriesList.forEach((s) =>
    s.points.forEach((p) => {
      allV.push(p.v);
      if (p.t < minT) minT = p.t;
      if (p.t > maxT) maxT = p.t;
    })
  );
  if (!allV.length) return;

  let minV = Math.min.apply(null, allV);
  let maxV = Math.max.apply(null, allV);
  if (maxV === minV) {
    maxV += 1;
    minV -= 1;
  }
  const vPad = (maxV - minV) * 0.2;
  minV -= vPad;
  maxV += vPad;
  if (minT === maxT) {
    minT -= 86400000; // 单点时左右各扩一天
    maxT += 86400000;
  }

  const x = (t) => PAD_L + ((t - minT) / (maxT - minT)) * plotW;
  const y = (v) => PAD_T + plotH - ((v - minV) / (maxV - minV)) * plotH;

  // 图例
  ctx.textAlign = "left";
  ctx.font = "11px sans-serif";
  let lx = PAD_L + 6;
  seriesList.forEach((s) => {
    ctx.fillStyle = s.color || COLORS[s.type];
    ctx.beginPath();
    ctx.arc(lx + 5, PAD_T - 14, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#666666";
    ctx.fillText(s.label, lx + 14, PAD_T - 10);
    lx += 16 + s.label.length * 13 + 20;
  });

  // 网格 + 价格刻度
  ctx.strokeStyle = "#f0f0f0";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#999999";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = minV + ((maxV - minV) * i) / ticks;
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(PAD_L, yy);
    ctx.lineTo(W - PAD_R, yy);
    ctx.stroke();
    ctx.fillText(Math.round(v), PAD_L - 6, yy + 3);
  }

  // 时间刻度（首/尾）
  ctx.textAlign = "center";
  ctx.fillText(fmtDate(new Date(minT)), PAD_L, H - 8);
  ctx.fillText(fmtDate(new Date(maxT)), W - PAD_R, H - 8);

  // 折线
  seriesList.forEach((s) => {
    const color = s.color || COLORS[s.type];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const px = x(p.t);
      const py = y(p.v);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();

    // 数据点
    ctx.fillStyle = color;
    s.points.forEach((p) => {
      ctx.beginPath();
      ctx.arc(x(p.t), y(p.v), 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  });
}

module.exports = { drawPriceChart };
