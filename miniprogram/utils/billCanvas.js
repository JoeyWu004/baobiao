// utils/billCanvas.js 报表 Canvas 2D 绘制与导出
// 依赖页面中有一个 <canvas type="2d" id="billCanvas"> 离屏画布
const { fmtMoney, locText } = require("./format");

const W = 750; // 逻辑宽度
const PAD = 40;
const CW = W - PAD * 2;

const TITLE_H = 96;
const HEAD_H = 48;
const ROW_H = 54;
const FOOT_H = 210;

// 单个导出画布高度上限（超过此值部分安卓机输出黑图）
const PAGE_MAX_H = 2200;

const COLS = [
  { ratio: 0.6, align: "center" }, // 序号
  { ratio: 2.0, align: "left" }, // 项目名称
  { ratio: 0.8, align: "center" }, // 数量
  { ratio: 0.8, align: "center" }, // 单位
  { ratio: 1.2, align: "right" }, // 单价
  { ratio: 1.4, align: "right" }, // 金额
  { ratio: 0.6, align: "left" }, // 备注
];

function colLayout() {
  const sum = COLS.reduce((s, c) => s + c.ratio, 0);
  let x = PAD;
  return COLS.map((c) => {
    const w = (CW * c.ratio) / sum;
    const item = { x, w, align: c.align };
    x += w;
    return item;
  });
}

// 在单元格内画文本，超出宽度自动省略号
function drawCellText(ctx, text, cell, x, y, centerY, maxW, baseFont) {
  ctx.font = baseFont;
  ctx.textBaseline = "middle";
  let str = text == null ? "" : String(text);
  if (str.length > 40) str = str.slice(0, 40); // 极长兜底
  // 超宽时按字符裁减加省略号
  while (str.length > 0 && ctx.measureText(str).width > maxW) {
    str = str.slice(0, str.length - 1);
  }
  if (str !== (text == null ? "" : String(text)) && str.length > 0) {
    while (ctx.measureText(str + "…").width > maxW && str.length > 0) {
      str = str.slice(0, str.length - 1);
    }
    str = str + "…";
  }
  let tx;
  if (cell.align === "right") {
    tx = x + cell.w - 12;
    ctx.textAlign = "right";
  } else if (cell.align === "center") {
    tx = x + cell.w / 2;
    ctx.textAlign = "center";
  } else {
    tx = x + 12;
    ctx.textAlign = "left";
  }
  ctx.fillText(str, tx, centerY);
}

function drawTableBorder(ctx, x0, y0, x1, y1) {
  ctx.strokeStyle = "#d9d9d9";
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
}

// 按宽度自动换行绘制文本
function drawWrappedText(ctx, text, x, y, maxW, lineH) {
  let line = "";
  let yy = y;
  const chars = String(text);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (line && ctx.measureText(line + ch).width > maxW) {
      ctx.fillText(line, x, yy);
      line = ch;
      yy += lineH;
    } else {
      line += ch;
    }
  }
  if (line) ctx.fillText(line, x, yy);
}

// 顶部信息块高度（客户+日期 + 可选位置）
function infoBlockH(report) {
  const hasLoc = !!locText(report);
  const lines = 1 + (hasLoc ? 1 : 0); // 客户+日期 + 位置
  return 30 + 44 * lines + 40;
}

// 标题字号随长度缩小
function titleFont(len) {
  if (len <= 2) return "bold 40px sans-serif";
  if (len <= 4) return "bold 36px sans-serif";
  if (len <= 8) return "bold 30px sans-serif";
  return "bold 24px sans-serif";
}

// 计算一页逻辑高度
function pageHeight(pageItems, report) {
  return TITLE_H + infoBlockH(report) + HEAD_H + pageItems.length * ROW_H + FOOT_H;
}

// 绘制一页（画布尺寸需已按 dpr 设置好）；startIndex 为本页起始序号（分页时序号连续）
function drawPage(ctx, report, pageItems, pageNo, pageCount, isLastPage, startIndex) {
  const rowsH = pageItems.length * ROW_H;
  const pageH = pageHeight(pageItems, report);
  const cols = colLayout();

  // 白底
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, pageH);

  let y = 0;

  // 标题（可改的报表名称）
  const title = report.title || "报表";
  ctx.fillStyle = "#111111";
  ctx.font = titleFont(title.length);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(title, W / 2, y + 46);

  // 客户+日期 / 位置(可选) —— 与工作表一致：居中
  y += TITLE_H;
  ctx.font = "26px sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "#333333";
  let lineY = y + 30;
  ctx.fillText("客户：" + report.customerName + "    日期：" + (report.date || ""), W / 2, lineY);
  lineY += 44;
  const lt = locText(report);
  if (lt) {
    ctx.fillStyle = "#666666";
    ctx.font = "24px sans-serif";
    ctx.fillText("位置：" + lt, W / 2, lineY);
    lineY += 44;
  }

  // 表头
  y = lineY + 46;
  ctx.fillStyle = "#f5f5f5";
  ctx.fillRect(PAD, y, CW, HEAD_H);
  ctx.fillStyle = "#666666";
  ctx.font = "20px sans-serif";
  ctx.textBaseline = "middle";
  const headers = ["序号", "项目名称", "数量", "单位", "单价（元）", "金额（元）", "备注"];
  cols.forEach((c, i) => {
    ctx.textAlign = c.align === "right" ? "right" : c.align === "center" ? "center" : "left";
    const tx =
      c.align === "right"
        ? c.x + c.w - 12
        : c.align === "center"
          ? c.x + c.w / 2
          : c.x + 12;
    ctx.fillText(headers[i], tx, y + HEAD_H / 2);
  });
  drawTableBorder(ctx, PAD, y, W - PAD, y + HEAD_H);

  // 明细行
  y += HEAD_H;
  ctx.fillStyle = "#333333";
  for (let i = 0; i < pageItems.length; i++) {
    const it = pageItems[i];
    const rowY = y + i * ROW_H;
    drawCellText(ctx, startIndex + i + 1, cols[0], cols[0].x, rowY, rowY + ROW_H / 2, cols[0].w - 8, "24px sans-serif");
    drawCellText(ctx, it.type === "goods" ? it.name : it.desc, cols[1], cols[1].x, rowY, rowY + ROW_H / 2, cols[1].w - 16, "26px sans-serif");
    drawCellText(ctx, it.type === "goods" ? it.quantity : "—", cols[2], cols[2].x, rowY, rowY + ROW_H / 2, cols[2].w - 8, "24px sans-serif");
    drawCellText(ctx, it.unit || "-", cols[3], cols[3].x, rowY, rowY + ROW_H / 2, cols[3].w - 8, "24px sans-serif");
    drawCellText(ctx, it.type === "goods" ? fmtMoney(it.price) : "—", cols[4], cols[4].x, rowY, rowY + ROW_H / 2, cols[4].w - 8, "24px sans-serif");
    drawCellText(ctx, fmtMoney(it.amount), cols[5], cols[5].x, rowY, rowY + ROW_H / 2, cols[5].w - 8, "26px sans-serif");
    drawCellText(ctx, it.remark || "", cols[6], cols[6].x, rowY, rowY + ROW_H / 2, cols[6].w - 8, "24px sans-serif");
    drawTableBorder(ctx, PAD, rowY, W - PAD, rowY + ROW_H);
  }

  // 合计 / 备注 / 页码
  y += rowsH;
  ctx.textAlign = "left";
  ctx.fillStyle = "#333333";
  ctx.font = "24px sans-serif";
  if (report.remark) {
    ctx.fillText("备注：" + report.remark, PAD, y + 30);
  }

  if (isLastPage) {
    // 合计高亮行：总合计居中 + 金额居右
    const totalH = 64;
    ctx.fillStyle = "#f5f7fa";
    ctx.fillRect(PAD, y + 52, CW, totalH);
    drawTableBorder(ctx, PAD, y + 52, W - PAD, y + 52 + totalH);
    ctx.fillStyle = "#111111";
    ctx.font = "bold 28px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("总合计（元）", W / 2, y + 52 + totalH / 2);
    ctx.textAlign = "right";
    ctx.fillText("¥" + fmtMoney(report.totalAmount), W - PAD - 12, y + 52 + totalH / 2);

    // 服务说明（账户绑定，存入报表）
    if (report.serviceNote) {
      ctx.fillStyle = "#666666";
      ctx.font = "22px sans-serif";
      ctx.textAlign = "left";
      drawWrappedText(ctx, report.serviceNote, PAD, y + 52 + totalH + 28, CW, 30);
    }
  } else {
    ctx.fillStyle = "#999999";
    ctx.font = "24px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("— 第 " + pageNo + " 页 —", W / 2, y + 80);
  }

  return pageH;
}

// 将报表渲染为图片（支持多页），返回临时文件路径数组
async function renderBillToImages(report, getQuery, dpr) {
  const items = report.items || [];

  const topBlockH = TITLE_H + infoBlockH(report) + HEAD_H;
  const bottomBlockH = FOOT_H;
  const rowsPerPage = Math.max(
    1,
    Math.floor((PAGE_MAX_H - topBlockH - bottomBlockH) / ROW_H)
  );
  const pageCount = Math.max(1, Math.ceil(items.length / rowsPerPage));

  const { node: canvas } = await new Promise((resolve) => {
    getQuery()
      .select("#billCanvas")
      .fields({ node: true, size: true })
      .exec((res) => resolve(res && res[0] ? res[0] : {}));
  });
  if (!canvas) throw new Error("未找到画布节点");

  const ctx = canvas.getContext("2d");
  const paths = [];

  for (let p = 0; p < pageCount; p++) {
    const pageItems = items.slice(p * rowsPerPage, (p + 1) * rowsPerPage);
    const isLast = p === pageCount - 1;
    const logicalH = pageHeight(pageItems, report);

    // 设置尺寸会重置画布，需先设尺寸再 scale 再绘制
    canvas.width = W * dpr;
    canvas.height = logicalH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawPage(ctx, report, pageItems, p + 1, pageCount, isLast, p * rowsPerPage);

    const tmp = await new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas,
        destWidth: W * dpr,
        destHeight: logicalH * dpr,
        success: (r) => resolve(r.tempFilePath),
        fail: reject,
      });
    });
    paths.push(tmp);
  }
  return paths;
}

module.exports = { renderBillToImages };
