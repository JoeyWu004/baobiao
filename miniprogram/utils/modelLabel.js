// utils/modelLabel.js 识别模型 id → 展示名
// 三个页面（确认页 / 进货详情页 / 我的·识别设置）共用一份，避免各写一份漂移。
//
// 必须精确匹配。原来 invoice-confirm 与 purchase-detail 用 /^kimi-k2/i 前缀判断，
// 任何 kimi-k2.x 的新模型（如 kimi-k2.7-code）都会被显示成「Kimi K2.6」；profile 则把
// 认不出的值兜底成列表第一项，同样会显示成「Kimi K2.6」。两种情况都会在做模型对照试验时
// 给出错误标注 —— 换了模型却显示同一个名字，结论直接失效。
// 所以：认不出来就原样显示 id，不要瞎猜。
// 只登记当前在用的模型 id。DeepSeek 改名前的旧 id（deepseek-v4-flash-vision-exp）已弃用，
// 不再留别名 —— 少数历史进货记录里若还存着它，会原样显示这串 id（也提示了它是老数据）。
const MODEL_LABELS = {
  "kimi-k2.6": "Kimi K2.6",
  "kimi-k3": "Kimi K3",
  "deepseek-flash": "DeepSeek V4.1 Flash",
};

function modelLabel(value) {
  const m = String(value || "");
  return MODEL_LABELS[m] || m;
}

module.exports = { MODEL_LABELS, modelLabel };
