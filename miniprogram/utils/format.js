// utils/format.js 格式化工具

// 金额格式化：保留两位小数
function fmtMoney(n) {
  const num = Number(n);
  if (isNaN(num)) return "0.00";
  return num.toFixed(2);
}

// 补零
function pad(n) {
  return n < 10 ? "0" + n : "" + n;
}

// Date 对象 → "YYYY-MM-DD"
function fmtDate(d) {
  if (!d) return "";
  if (typeof d === "string") {
    // 兼容 "YYYY-MM-DD" 字符串
    const m = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return d.slice(0, 10);
    return d;
  }
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
  );
}

// Date 对象 → "YYYY-MM-DD HH:mm"
function fmtDateTime(d) {
  if (!d) return "";
  return (
    fmtDate(d) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

// 兼容各种日期序列化格式（Date / 字符串 / { $date: ms } / 时间戳）
function toDate(v) {
  if (!v) return null;
  if (typeof v === "number" || typeof v === "string") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  if (v instanceof Date) return v;
  if (typeof v === "object" && v.$date != null) {
    const d = new Date(v.$date);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// 金额计算：统一四舍五入到两位小数，避免浮点误差
function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

// 组合位置显示文本：定位地点 + 具体门牌号（独立两部分）
function locText(r) {
  const place = r && r.location && (r.location.address || r.location.name);
  const specific = r && r.address;
  const parts = [];
  if (place) parts.push(place);
  if (specific) parts.push(specific);
  return parts.join(" / ");
}

module.exports = {
  fmtMoney,
  fmtDate,
  fmtDateTime,
  roundMoney,
  toDate,
  locText,
};
